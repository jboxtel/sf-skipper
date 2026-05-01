function getOrgBase() {
  return window.location.origin;
}

// Translate the current host into the my.salesforce.com REST API host.
// Salesforce 302s lightning.force.com → my.salesforce.com, and Chrome strips
// the Authorization header across redirects, so we must call the API host directly.
function getApiBase() {
  var h = window.location.hostname;
  if (/\.lightning\.force\.com$/.test(h)) {
    return 'https://' + h.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
  }
  // Already on a my.salesforce.com (or sandbox variant) — use as-is
  return window.location.origin;
}

function getObjectManagerBase() {
  return `${getOrgBase()}/lightning/setup/ObjectManager`;
}

var OBJECT_SUB_PAGES = OBJECT_SUB_PAGES || [
  { label: "Object Overview",           segment: "view" },
  { label: "Fields & Relationships",    segment: "FieldsAndRelationships/view" },
  { label: "Page Layouts",              segment: "PageLayouts/view" },
  { label: "Lightning Record Pages",    segment: "LightningPages/view" },
  { label: "Compact Layouts",           segment: "CompactLayouts/view" },
  { label: "Field Sets",                segment: "FieldSets/view" },
  { label: "Validation Rules",          segment: "ValidationRules/view" },
  { label: "Record Types",              segment: "RecordTypes/view" },
  { label: "Triggers",                  segment: "ApexTriggers/view" },
  { label: "Search Layouts",            segment: "SearchLayouts/view" },
  { label: "Limits",                    segment: "Limits/view" },
  { label: "Related Lookup Filters",    segment: "RelatedLookupFilters/view" },
  { label: "Hierarchy Columns",         segment: "HierarchyColumns/view" },
  { label: "Sharing Reason",            segment: "SharingReasons/view" },
  { label: "Sharing Rules",             segment: "SharingRules/view" },
];

function buildObjectSubPageUrl(apiName, segment) {
  return `${getObjectManagerBase()}/${apiName}/${segment}`;
}

var SETUP_QUICK_LINKS = SETUP_QUICK_LINKS || [
  { label: "Object Manager",            url: () => `${getOrgBase()}/lightning/setup/ObjectManager/home` },
  { label: "Profiles",                  url: () => `${getOrgBase()}/lightning/setup/Profiles/home` },
  { label: "Permission Sets",           url: () => `${getOrgBase()}/lightning/setup/PermSets/home` },
  { label: "Permission Set Groups",     url: () => `${getOrgBase()}/lightning/setup/PermSetGroups/home` },
  { label: "Roles",                     url: () => `${getOrgBase()}/lightning/setup/Roles/page?setupid=Roles` },
  { label: "Users",                     url: () => `${getOrgBase()}/lightning/setup/ManageUsers/home` },
  { label: "Flows",                     url: () => `${getOrgBase()}/lightning/setup/Flows/home` },
  { label: "Apex Classes",              url: () => `${getOrgBase()}/lightning/setup/ApexClasses/home` },
  { label: "Apex Triggers",             url: () => `${getOrgBase()}/lightning/setup/ApexTriggers/home` },
  { label: "Custom Metadata Types",     url: () => `${getOrgBase()}/lightning/setup/CustomMetadata/home` },
  { label: "Custom Settings",           url: () => `${getOrgBase()}/lightning/setup/CustomSettings/home` },
  { label: "Custom Labels",             url: () => `${getOrgBase()}/lightning/setup/ExternalStrings/home` },
  { label: "Named Credentials",         url: () => `${getOrgBase()}/lightning/setup/NamedCredential/home` },
  { label: "External Credentials",      url: () => `${getOrgBase()}/lightning/setup/ExternalCredential/home` },
  { label: "Remote Site Settings",      url: () => `${getOrgBase()}/lightning/setup/SecurityRemoteProxy/home` },
  { label: "Connected Apps",            url: () => `${getOrgBase()}/lightning/setup/ConnectedApplication/home` },
  { label: "App Manager",               url: () => `${getOrgBase()}/lightning/setup/NavigationMenus/home` },
  { label: "Reports & Dashboards",      url: () => `${getOrgBase()}/lightning/setup/ReportsDashboards/home` },
  { label: "Email Templates",           url: () => `${getOrgBase()}/lightning/setup/CommunicationTemplatesEmail/home` },
  { label: "Workflow Rules",            url: () => `${getOrgBase()}/lightning/setup/WorkflowRules/home` },
  { label: "Process Builder",           url: () => `${getOrgBase()}/lightning/setup/ProcessAutomation/home` },
  { label: "Sharing Settings",          url: () => `${getOrgBase()}/lightning/setup/SecuritySharing/home` },
  { label: "Setup Home",                url: () => `${getOrgBase()}/lightning/setup/SetupOneHome/home` },
  { label: "Security Health Check",     url: () => `${getOrgBase()}/lightning/setup/HealthCheck/home` },
  { label: "Login History",             url: () => `${getOrgBase()}/lightning/setup/LoginHistory/home` },
  { label: "Audit Trail",               url: () => `${getOrgBase()}/lightning/setup/AuditTrail/home` },
  { label: "Installed Packages",        url: () => `${getOrgBase()}/lightning/setup/ImportedPackage/home` },
  { label: "Custom Objects",            url: () => `${getOrgBase()}/lightning/setup/ObjectManager/home` },
  { label: "Lightning App Builder",     url: () => `${getOrgBase()}/lightning/setup/FlexiPageList/home` },
  { label: "Static Resources",          url: () => `${getOrgBase()}/lightning/setup/StaticResources/home` },
  { label: "Email Services",            url: () => `${getOrgBase()}/lightning/setup/EmailToApexFunction/home` },
  { label: "Sandboxes",                 url: () => `${getOrgBase()}/lightning/setup/DataManagementCreateTestInstance/home` },
  { label: "Data Import Wizard",        url: () => `${getOrgBase()}/lightning/setup/DataManagementDataImporter/home` },
  { label: "Data Export",               url: () => `${getOrgBase()}/lightning/setup/DataManagementExportNow/home` },
  { label: "Duplicate Rules",           url: () => `${getOrgBase()}/lightning/setup/DuplicateRules/home` },
  { label: "Matching Rules",            url: () => `${getOrgBase()}/lightning/setup/MatchingRules/home` },
  { label: "Queue Management",          url: () => `${getOrgBase()}/lightning/setup/Queues/home` },
  { label: "Public Groups",             url: () => `${getOrgBase()}/lightning/setup/PublicGroups/home` },
  { label: "Territories",               url: () => `${getOrgBase()}/lightning/setup/Territories/home` },
  { label: "Assignment Rules",          url: () => `${getOrgBase()}/lightning/setup/LeadRules/home` },
  { label: "Paused and Failed Flow Interviews", url: () => `${getOrgBase()}/lightning/setup/PausedFlows/home` },
  { label: "Flow Trigger Explorer",     url: () => `${getOrgBase()}/lightning/setup/FlowTriggerExplorer/home` },
  { label: "Process Automation Settings", url: () => `${getOrgBase()}/lightning/setup/AutomationAppSettings/home` },
  { label: "Apex Jobs",                 url: () => `${getOrgBase()}/lightning/setup/AsyncApexJobs/home` },
  { label: "Apex Test Execution",       url: () => `${getOrgBase()}/lightning/setup/ApexTestQueue/home` },
  { label: "Scheduled Jobs",            url: () => `${getOrgBase()}/lightning/setup/ScheduledJobs/home` },
  { label: "Login Flows",               url: () => `${getOrgBase()}/lightning/setup/LoginFlow/home` },
  { label: "Custom Permissions",        url: () => `${getOrgBase()}/lightning/setup/CustomPermissions/home` },
  { label: "Email Deliverability",      url: () => `${getOrgBase()}/lightning/setup/OrgEmailSettings/home` },
  { label: "My Domain",                 url: () => `${getOrgBase()}/lightning/setup/OrgDomain/home` },
  { label: "Session Settings",          url: () => `${getOrgBase()}/lightning/setup/SecuritySession/home` },
  { label: "Password Policies",         url: () => `${getOrgBase()}/lightning/setup/SecurityPolicies/home` },
];
