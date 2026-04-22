/**
 * Field Mapping: Excel Columns → Database Tables
 *
 * Maps columns from both uploaded Excel files to the normalized
 * Supabase/Postgres schema. Used by the ingestion pipeline.
 */

// ─── File 1: Employee_Timesheet_Compliance_1-31_March.xlsx ───
// Columns (17): Department Name, Sub-Function, Employee ID,
//   Employee Name, Designation, Employee Country, Location,
//   Date of Joining, Date of Exit, Holidays (Days), Leaves (Days),
//   Available Hours, Chargeable, Non-Chargeable, Total Hours,
//   Chargeability %, Compliance %

export const TIMESHEET_COMPLIANCE_MAP = {
  // ─ employees table ─
  'Employee ID':       { table: 'employees',    field: 'employee_id',      type: 'text',    required: true  },
  'Employee Name':     { table: 'employees',    field: 'name',             type: 'text',    required: true  },
  'Designation':       { table: 'designations', field: 'name',             type: 'lookup',  required: false },
  'Department Name':   { table: 'departments',  field: 'name',             type: 'lookup',  required: true  },
  'Sub-Function':      { table: 'sub_functions', field: 'name',            type: 'lookup',  required: false },
  'Employee Country':  { table: 'locations',    field: 'country',          type: 'text',    required: false },
  'Location':          { table: 'locations',    field: 'name',             type: 'lookup',  required: false },
  'Date of Joining':   { table: 'employees',    field: 'date_of_joining',  type: 'date',    required: false },
  'Date of Exit':      { table: 'employees',    field: 'date_of_exit',     type: 'date',    required: false },

  // ─ timesheet_compliance table ─
  'Holidays (Days)':   { table: 'timesheet_compliance', field: 'holidays_days',        type: 'number', required: false },
  'Leaves (Days)':     { table: 'timesheet_compliance', field: 'leaves_days',          type: 'number', required: false },
  'Available Hours':   { table: 'timesheet_compliance', field: 'available_hours',      type: 'number', required: true  },
  'Chargeable':        { table: 'timesheet_compliance', field: 'chargeable_hours',     type: 'number', required: false },
  'Non-Chargeable':    { table: 'timesheet_compliance', field: 'non_chargeable_hours', type: 'number', required: false },
  'Total Hours ':      { table: 'timesheet_compliance', field: 'total_hours',          type: 'number', required: false },
  'Chargeability %':   { table: 'timesheet_compliance', field: 'chargeability_pct',    type: 'number', required: false },
  'Compliance %':      { table: 'timesheet_compliance', field: 'compliance_pct',       type: 'number', required: false },
} as const


// ─── File 2: Regionwise view.xlsx ────────────────────────────
// Columns (20): Month, Department Name, Sub-Function, Employee ID,
//   Employee Name, Designation, Region, Location, Employee Region,
//   Date of Joining, Date of Exit, Holidays (Days), Leaves (Days),
//   Available Hours, Chargeable, Non-Chargeable, Total Hours,
//   Chargeability %, Compliance %, Category

export const REGIONWISE_MAP = {
  // ─ employees table ─
  'Employee ID':       { table: 'employees',    field: 'employee_id',      type: 'text',    required: true  },
  'Employee Name':     { table: 'employees',    field: 'name',             type: 'text',    required: true  },
  'Designation':       { table: 'designations', field: 'name',             type: 'lookup',  required: false },
  'Department Name':   { table: 'departments',  field: 'name',             type: 'lookup',  required: true  },
  'Sub-Function':      { table: 'sub_functions', field: 'name',            type: 'lookup',  required: false },
  'Region':            { table: 'regions',      field: 'name',             type: 'lookup',  required: false },
  'Location':          { table: 'locations',    field: 'name',             type: 'lookup',  required: false },
  'Employee Region':   { table: 'employees',    field: 'employee_region',  type: 'text',    required: false },
  'Date of Joining':   { table: 'employees',    field: 'date_of_joining',  type: 'date',    required: false },
  'Date of Exit':      { table: 'employees',    field: 'date_of_exit',     type: 'date',    required: false },

  // ─ timesheet_compliance table ─
  'Month':             { table: 'timesheet_compliance', field: 'period_month',         type: 'text',   required: true  },
  'Holidays (Days)':   { table: 'timesheet_compliance', field: 'holidays_days',        type: 'number', required: false },
  'Leaves (Days)':     { table: 'timesheet_compliance', field: 'leaves_days',          type: 'number', required: false },
  'Available Hours':   { table: 'timesheet_compliance', field: 'available_hours',      type: 'number', required: true  },
  'Chargeable':        { table: 'timesheet_compliance', field: 'chargeable_hours',     type: 'number', required: false },
  'Non-Chargeable':    { table: 'timesheet_compliance', field: 'non_chargeable_hours', type: 'number', required: false },
  'Total Hours ':      { table: 'timesheet_compliance', field: 'total_hours',          type: 'number', required: false },
  'Chargeability %':   { table: 'timesheet_compliance', field: 'chargeability_pct',    type: 'number', required: false },
  'Compliance %':      { table: 'timesheet_compliance', field: 'compliance_pct',       type: 'number', required: false },
  'Category ':         { table: 'timesheet_compliance', field: 'category',             type: 'text',   required: false },
} as const


// ─── File 3: Forecast Tracker ────────────────────────────────
// Columns: Employee ID, DOJ, Email, Secondment/Onsite/Remote,
//   MTD utilization, WC utilization, YTD utilization, Comments,
//   Rocketlane, Resource Name, Resource Grade, Location, Sub Team,
//   FT Core, Current Project Name, Current EM/EP, Project Type,
//   + 84 weekly date columns (week-start dates as headers)

export const FORECAST_TRACKER_MAP = {
  // ─ employees table ─
  'Employee ID':               { table: 'employees',    field: 'employee_id',      type: 'text',    required: true  },
  'Resource Name':             { table: 'employees',    field: 'name',             type: 'text',    required: true  },
  'Email':                     { table: 'employees',    field: 'email',            type: 'text',    required: false },
  'DOJ':                       { table: 'employees',    field: 'date_of_joining',  type: 'date',    required: false },
  'Location':                  { table: 'locations',    field: 'name',             type: 'lookup',  required: false },
  'Resource Grade':            { table: 'designations', field: 'name',             type: 'lookup',  required: false },
  'Sub Team':                  { table: 'sub_functions', field: 'name',            type: 'lookup',  required: false },
  'Secondment/Onsite/Remote':  { table: 'employees',    field: 'work_mode',        type: 'text',    required: false },
  'FT Core':                   { table: 'employees',    field: 'ft_core',          type: 'text',    required: false },
  'Rocketlane':                { table: 'employees',    field: 'rocketlane_status', type: 'text',   required: false },

  // ─ current project context ─
  'Current Project Name':      { table: 'projects',     field: 'name',             type: 'text',    required: false },
  'Current EM/EP':             { table: 'projects',     field: 'engagement_manager', type: 'text',  required: false },
  'Project Type':              { table: 'projects',     field: 'project_type',     type: 'text',    required: false },

  // ─ utilization snapshots ─
  'MTD':                       { table: 'utilization_snapshots', field: 'mtd_utilization', type: 'number', required: false },
  'WC':                        { table: 'utilization_snapshots', field: 'wtd_utilization', type: 'number', required: false },
  'YTD':                       { table: 'utilization_snapshots', field: 'ytd_utilization', type: 'number', required: false },
  'Comments':                  { table: 'utilization_snapshots', field: 'comments',        type: 'text',   required: false },
} as const

// Known forecast tracker "master data" column headers
// (anything not in this set that looks like a date is a weekly forecast column)
export const FORECAST_MASTER_COLUMNS = new Set([
  'Employee ID', 'DOJ', 'Email', 'Secondment/Onsite/Remote',
  'Rocketlane', 'Resource Name', 'Resource Grade', 'Location',
  'Sub Team', 'FT Core', 'Current Project Name', 'Current EM/EP',
  'Project Type',
])

// Columns that hold utilization metrics (partial-match on header)
export const FORECAST_UTILIZATION_PREFIXES = ['MTD', 'WC', 'YTD', 'Comments']


// ─── Column Header Aliases ───────────────────────────────────
// Handle slight variations in column names across uploads
export const COLUMN_ALIASES: Record<string, string> = {
  'Total Hours':          'Total Hours ',       // trailing space in source
  'Category':             'Category ',          // trailing space in source
  'Emp ID':               'Employee ID',
  'Emp Name':             'Employee Name',
  'Dept Name':            'Department Name',
  'Sub Function':         'Sub-Function',
  'Country':              'Employee Country',
  'Joining Date':         'Date of Joining',
  'Exit Date':            'Date of Exit',
  'Holidays':             'Holidays (Days)',
  'Leaves':               'Leaves (Days)',
  'Available Hrs':        'Available Hours',
  'Chargeable Hrs':       'Chargeable',
  'Non-Chargeable Hrs':   'Non-Chargeable',
  'Chargeability':        'Chargeability %',
  'Compliance':           'Compliance %',
  // Forecast tracker aliases
  'Name':                 'Resource Name',
  'Grade':                'Resource Grade',
  'Team':                 'Sub Team',
  'Sub-Team':             'Sub Team',
  'Project Name':         'Current Project Name',
  'EM/EP':                'Current EM/EP',
  'Engagement Manager':   'Current EM/EP',
}
