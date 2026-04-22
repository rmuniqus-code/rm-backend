/**
 * parse-skill-mapping.ts
 *
 * Reads ARC GRC Skillmapping.xlsx and upserts into:
 *   - employee_skills  (primary + secondary, deduplicated)
 *   - employee_sectors (primary FK update + secondary free-text rows)
 *
 * Run:
 *   npx ts-node scripts/parse-skill-mapping.ts \
 *     --file "../../ARC GRC Skillmapping.xlsx"
 *
 * Env vars required (same as the rest of the app):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import * as xlsx from "xlsx";
import { createClient } from "@supabase/supabase-js";
import * as path from "path";

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const FILE_PATH =
  process.argv.find((a) => a.startsWith("--file="))?.replace("--file=", "") ??
  process.argv[process.argv.indexOf("--file") + 1] ??
  path.resolve(__dirname, "../../ARC GRC Skillmapping.xlsx");

// ─── Types ───────────────────────────────────────────────────────────────────

interface RawRow {
  email: string;
  employeeId: string;
  name: string;
  designation: string;
  location: string;
  primarySkill: string;
  secondarySkills: string;
  tertiarySkills: string;
  primarySector: string;
  secondarySectors: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Split a semicolon-delimited cell, trim, drop blanks and "Not Applicable" */
function splitCell(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && s !== "Not Applicable");
}

/**
 * Build the ordered, deduplicated list of secondary skills for one employee.
 *
 * Rules:
 *  1. Walk secondary values first (order 1, 2), then tertiary (continues seq).
 *  2. Skip if already seen (dedup across tiers).
 *  3. Skip if it equals the employee's primary skill (primary stays separate).
 *
 * Returns [{skillName, order}] where order is 1-based rank within secondary bucket.
 */
function buildSecondarySkills(
  primary: string,
  secondary: string,
  tertiary: string
): { skillName: string; order: number }[] {
  const seen = new Set<string>([primary?.trim()]);
  const result: { skillName: string; order: number }[] = [];
  let order = 1;

  for (const skillName of [...splitCell(secondary), ...splitCell(tertiary)]) {
    if (seen.has(skillName)) continue;
    seen.add(skillName);
    result.push({ skillName, order });
    order++;
  }

  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Load Excel
  console.log(`Reading: ${FILE_PATH}`);
  const wb = xlsx.readFile(FILE_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    defval: "",
  }) as string[][];

  // Skip header row
  const dataRows: RawRow[] = rows.slice(1).map((r) => ({
    email: String(r[0] ?? "").trim(),
    employeeId: String(r[1] ?? "").trim(),
    name: String(r[2] ?? "").trim(),
    designation: String(r[3] ?? "").trim(),
    location: String(r[4] ?? "").trim(),
    primarySkill: String(r[5] ?? "").trim(),
    secondarySkills: String(r[6] ?? "").trim(),
    tertiarySkills: String(r[7] ?? "").trim(),
    primarySector: String(r[8] ?? "").trim(),
    secondarySectors: String(r[9] ?? "").trim(),
  }));

  console.log(`Parsed ${dataRows.length} employee rows`);

  // 2. Fetch lookup tables
  const { data: skillsData } = await supabase.from("skills").select("id, name");
  const { data: sectorsData } = await supabase
    .from("sectors")
    .select("id, name");

  if (!skillsData?.length) throw new Error("skills table is empty — run migration 004 first");

  const skillMap = new Map<string, string>(skillsData.map((s) => [s.name, s.id]));
  const sectorMap = new Map<string, string>(
    (sectorsData ?? []).map((s) => [s.name, s.id])
  );

  // 3. Fetch all employees by employee_id
  const { data: employeeData } = await supabase
    .from("employees")
    .select("id, employee_id, email");

  if (!employeeData?.length) throw new Error("employees table is empty");

  const empByCode = new Map<string, string>(
    employeeData.map((e) => [e.employee_id, e.id])
  );
  const empByEmail = new Map<string, string>(
    employeeData.map((e) => [e.email?.toLowerCase(), e.id])
  );

  // 4. Build insert payloads
  const empSkillsInsert: {
    employee_id: string;
    skill_id: string;
    skill_type: string;
    skill_order: number;
  }[] = [];

  const empSectorsInsert: {
    employee_id: string;
    sector_id: string | null;
    raw_name: string;
  }[] = [];

  const employeePrimarySectorUpdates: {
    employeeUuid: string;
    sectorId: string | null;
  }[] = [];

  let skippedCount = 0;

  for (const row of dataRows) {
    if (!row.email && !row.employeeId) continue;

    // Resolve employee UUID
    const employeeUuid =
      empByCode.get(row.employeeId) ??
      empByEmail.get(row.email.toLowerCase());

    if (!employeeUuid) {
      console.warn(
        `  SKIP — employee not found: ${row.employeeId} / ${row.email}`
      );
      skippedCount++;
      continue;
    }

    // ── Primary skill ──────────────────────────────────────
    const primarySkillId = skillMap.get(row.primarySkill);
    if (row.primarySkill && !primarySkillId) {
      console.warn(`  WARN — unknown primary skill "${row.primarySkill}" (${row.email})`);
    }
    if (primarySkillId) {
      empSkillsInsert.push({
        employee_id: employeeUuid,
        skill_id: primarySkillId,
        skill_type: "primary",
        skill_order: 1,
      });
    }

    // ── Secondary skills (merged + deduped) ────────────────
    for (const { skillName, order } of buildSecondarySkills(
      row.primarySkill,
      row.secondarySkills,
      row.tertiarySkills
    )) {
      const skillId = skillMap.get(skillName);
      if (!skillId) {
        console.warn(`  WARN — unknown secondary skill "${skillName}" (${row.email})`);
        continue;
      }
      empSkillsInsert.push({
        employee_id: employeeUuid,
        skill_id: skillId,
        skill_type: "secondary",
        skill_order: order,
      });
    }

    // ── Primary sector ─────────────────────────────────────
    const primarySectorId = sectorMap.get(row.primarySector) ?? null;
    employeePrimarySectorUpdates.push({
      employeeUuid,
      sectorId: primarySectorId,
    });

    // ── Secondary sectors (free-text) ──────────────────────
    for (const raw of splitCell(row.secondarySectors)) {
      empSectorsInsert.push({
        employee_id: employeeUuid,
        sector_id: sectorMap.get(raw) ?? null,
        raw_name: raw,
      });
    }
  }

  console.log(
    `Prepared ${empSkillsInsert.length} employee_skill rows, ` +
      `${empSectorsInsert.length} employee_sector rows`
  );
  if (skippedCount) console.warn(`Skipped ${skippedCount} rows (employee not found)`);

  // 5. Upsert employee_skills
  // ON CONFLICT (employee_id, skill_id) → update skill_type + skill_order
  if (empSkillsInsert.length) {
    const CHUNK = 500;
    for (let i = 0; i < empSkillsInsert.length; i += CHUNK) {
      const chunk = empSkillsInsert.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("employee_skills")
        .upsert(chunk, { onConflict: "employee_id,skill_id" });
      if (error) throw new Error(`employee_skills upsert failed: ${error.message}`);
    }
    console.log(`Upserted ${empSkillsInsert.length} employee_skills rows`);
  }

  // 6. Upsert employee_sectors
  if (empSectorsInsert.length) {
    const CHUNK = 500;
    for (let i = 0; i < empSectorsInsert.length; i += CHUNK) {
      const chunk = empSectorsInsert.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("employee_sectors")
        .upsert(chunk, { onConflict: "employee_id,raw_name" });
      if (error) throw new Error(`employee_sectors upsert failed: ${error.message}`);
    }
    console.log(`Upserted ${empSectorsInsert.length} employee_sectors rows`);
  }

  // 7. Update employees.primary_sector_id
  if (employeePrimarySectorUpdates.length) {
    for (const { employeeUuid, sectorId } of employeePrimarySectorUpdates) {
      const { error } = await supabase
        .from("employees")
        .update({ primary_sector_id: sectorId })
        .eq("id", employeeUuid);
      if (error)
        console.warn(
          `  WARN — could not update sector for ${employeeUuid}: ${error.message}`
        );
    }
    console.log(`Updated primary_sector_id on ${employeePrimarySectorUpdates.length} employees`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
