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
  // The new Setup domain (<org>.my.salesforce-setup.com, sandboxes
  // <org>--<sb>.sandbox.my.salesforce-setup.com) doesn't serve the REST API.
  if (/\.salesforce-setup\.com$/.test(h)) {
    return 'https://' + h.replace(/\.salesforce-setup\.com$/, '.salesforce.com');
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

// CMDT "Manage Records" URL — opens the records list for a custom metadata type.
// keyPrefix is the type's 3-char key prefix (e.g. "m0u"), available from describeGlobal.
function buildCmdtManageRecordsUrl(keyPrefix) {
  var inner = '/' + keyPrefix + '?setupid=CustomMetadata';
  return `${getOrgBase()}/lightning/setup/CustomMetadata/page?address=${encodeURIComponent(inner)}`;
}

function buildCmdtObjectDefinitionUrl(entityId) {
  // CMDTs use Setup > Custom Metadata with the entity definition ID (01Ixx…).
  var inner = '/' + entityId + '?setupid=CustomMetadata';
  return `${getOrgBase()}/lightning/setup/CustomMetadata/page?address=${encodeURIComponent(inner)}`;
}

var SETUP_QUICK_LINKS = SETUP_QUICK_LINKS || [
  { label: "Object Manager",            url: () => `${getOrgBase()}/lightning/setup/ObjectManager/home` },
  { label: "Profiles",                      url: () => `${getOrgBase()}/lightning/setup/EnhancedProfiles/home` },
  { label: "Permission Sets",           url: () => `${getOrgBase()}/lightning/setup/PermSets/home` },
  { label: "Permission Set Groups",     url: () => `${getOrgBase()}/lightning/setup/PermSetGroups/home` },
  { label: "Roles",                         url: () => `${getOrgBase()}/lightning/setup/Roles/home` },
  { label: "Users",                     url: () => `${getOrgBase()}/lightning/setup/ManageUsers/home` },
  { label: "Flows",                     url: () => `${getOrgBase()}/lightning/setup/Flows/home` },
  { label: "Apex Classes",              url: () => `${getOrgBase()}/lightning/setup/ApexClasses/home` },
  { label: "Apex Triggers",             url: () => `${getOrgBase()}/lightning/setup/ApexTriggers/home` },
  { label: "Custom Metadata Types",     url: () => `${getOrgBase()}/lightning/setup/CustomMetadata/home` },
  { label: "Custom Settings",           url: () => `${getOrgBase()}/lightning/setup/CustomSettings/home` },
  { label: "Custom Labels",             url: () => `${getOrgBase()}/lightning/setup/ExternalStrings/home` },
  { label: "Named Credentials",         url: () => `${getOrgBase()}/lightning/setup/NamedCredential/home` },
  { label: "Remote Site Settings",      url: () => `${getOrgBase()}/lightning/setup/SecurityRemoteProxy/home` },
  { label: "Connected Apps",            url: () => `${getOrgBase()}/lightning/setup/ConnectedApplication/home` },
  { label: "App Manager",               url: () => `${getOrgBase()}/lightning/setup/NavigationMenus/home` },
  { label: "Reports and Dashboards Settings", url: () => `${getOrgBase()}/lightning/setup/ReportUI/home` },
  { label: "Email Templates",           url: () => `${getOrgBase()}/lightning/setup/CommunicationTemplatesEmail/home` },
  { label: "Workflow Rules",            url: () => `${getOrgBase()}/lightning/setup/WorkflowRules/home` },
  { label: "Process Builder",           url: () => `${getOrgBase()}/lightning/setup/ProcessAutomation/home` },
  { label: "Sharing Settings",          url: () => `${getOrgBase()}/lightning/setup/SecuritySharing/home` },
  { label: "Setup Home",                url: () => `${getOrgBase()}/lightning/setup/SetupOneHome/home` },
  { label: "Security Health Check",     url: () => `${getOrgBase()}/lightning/setup/HealthCheck/home` },
  { label: "Login History",                 url: () => `${getOrgBase()}/lightning/setup/OrgLoginHistory/home` },
  { label: "Setup Audit Trail",             url: () => `${getOrgBase()}/lightning/setup/SecurityEvents/home` },
  { label: "Installed Packages",        url: () => `${getOrgBase()}/lightning/setup/ImportedPackage/home` },
  { label: "Custom Objects",            url: () => `${getOrgBase()}/lightning/setup/ObjectManager/home` },
  { label: "Lightning App Builder",     url: () => `${getOrgBase()}/lightning/setup/FlexiPageList/home` },
  { label: "Static Resources",          url: () => `${getOrgBase()}/lightning/setup/StaticResources/home` },
  { label: "Email Services",            url: () => `${getOrgBase()}/lightning/setup/EmailToApexFunction/home` },
  { label: "Sandboxes",                 url: () => `${getOrgBase()}/lightning/setup/DataManagementCreateTestInstance/home` },
  { label: "Data Import Wizard",        url: () => `${getOrgBase()}/lightning/setup/DataManagementDataImporter/home` },
  { label: "Data Export",                   url: () => `${getOrgBase()}/lightning/setup/DataManagementExport/home` },
  { label: "Duplicate Rules",           url: () => `${getOrgBase()}/lightning/setup/DuplicateRules/home` },
  { label: "Matching Rules",            url: () => `${getOrgBase()}/lightning/setup/MatchingRules/home` },
  { label: "Queue Management",          url: () => `${getOrgBase()}/lightning/setup/Queues/home` },
  { label: "Public Groups",             url: () => `${getOrgBase()}/lightning/setup/PublicGroups/home` },
  { label: "Territory Settings",            url: () => `${getOrgBase()}/lightning/setup/Territory2Settings/home` },
  { label: "Assignment Rules",          url: () => `${getOrgBase()}/lightning/setup/LeadRules/home` },
  { label: "Apex Jobs",                 url: () => `${getOrgBase()}/lightning/setup/AsyncApexJobs/home` },
  { label: "Scheduled Jobs",            url: () => `${getOrgBase()}/lightning/setup/ScheduledJobs/home` },
  { label: "Apex Test Execution",       url: () => `${getOrgBase()}/lightning/setup/ApexTestQueue/home` },
  { label: "Debug Logs",                url: () => `${getOrgBase()}/lightning/setup/ApexDebugLogs/home` },
  { label: "Debug Mode",                    url: () => `${getOrgBase()}/lightning/setup/UserDebugModeSetup/home` },
  { label: "Deploy Status",             url: () => `${getOrgBase()}/lightning/setup/DeployStatus/home` },
  { label: "Email Logs",                url: () => `${getOrgBase()}/lightning/setup/EmailLogFiles/home` },
  { label: "Bulk Data Load Jobs",       url: () => `${getOrgBase()}/lightning/setup/AsyncApiJobStatus/home` },
  { label: "Outbound Messages",         url: () => `${getOrgBase()}/lightning/setup/WorkflowOutboundMessaging/home` },
  { label: "Visualforce Pages",         url: () => `${getOrgBase()}/lightning/setup/ApexPages/home` },
  { label: "Visualforce Components",    url: () => `${getOrgBase()}/lightning/setup/ApexComponents/home` },
  { label: "Lightning Components",      url: () => `${getOrgBase()}/lightning/setup/LightningComponentBundles/home` },
  { label: "Custom Permissions",        url: () => `${getOrgBase()}/lightning/setup/CustomPermissions/home` },
  { label: "Platform Events",           url: () => `${getOrgBase()}/lightning/setup/EventObjects/home` },
  { label: "Big Objects",               url: () => `${getOrgBase()}/lightning/setup/BigObjects/home` },
  { label: "Translation Language Settings", url: () => `${getOrgBase()}/lightning/setup/LabelWorkbenchSetup/home` },
  { label: "Session Settings",          url: () => `${getOrgBase()}/lightning/setup/SecuritySession/home` },
  { label: "Password Policies",         url: () => `${getOrgBase()}/lightning/setup/SecurityPolicies/home` },
  { label: "Login Flows",               url: () => `${getOrgBase()}/lightning/setup/LoginFlow/home` },
  { label: "Company Information",       url: () => `${getOrgBase()}/lightning/setup/CompanyProfileInfo/home` },
  { label: "System Overview (API Usage)",   url: () => `${getOrgBase()}/lightning/setup/SystemOverview/home` },
  { label: "Field Accessibility",       url: () => `${getOrgBase()}/lightning/setup/FieldAccessibility/home` },
  { label: "Paused and Failed Flow Interviews", url: () => `${getOrgBase()}/lightning/setup/Pausedflows/home` },
  { label: "Approval Processes",        url: () => `${getOrgBase()}/lightning/setup/ApprovalProcesses/home` },
  { label: "Process Automation Settings",   url: () => `${getOrgBase()}/lightning/setup/WorkflowSettings/home` },
  { label: "My Domain",                 url: () => `${getOrgBase()}/lightning/setup/DomainNames/home` },
  { label: "Single Sign-On Settings",   url: () => `${getOrgBase()}/lightning/setup/SingleSignOn/home` },
  { label: "Authentication Providers",  url: () => `${getOrgBase()}/lightning/setup/AuthProviders/home` },
  { label: "Certificate and Key Management", url: () => `${getOrgBase()}/lightning/setup/CertificatesAndKeysManagement/home` },
  { label: "Network Access",            url: () => `${getOrgBase()}/lightning/setup/NetworkAccess/home` },
  { label: "Trusted URLs",                  url: () => `${getOrgBase()}/lightning/setup/SecurityCspTrustedSite/home` },
  { label: "External Data Sources",     url: () => `${getOrgBase()}/lightning/setup/ExternalDataSource/home` },
  { label: "External Services",         url: () => `${getOrgBase()}/lightning/setup/ExternalServices/home` },
  { label: "Global Actions",                url: () => `${getOrgBase()}/lightning/setup/GlobalActions/home` },
  { label: "Publisher Layouts",         url: () => `${getOrgBase()}/lightning/setup/GlobalPublisherLayouts/home` },
  { label: "Digital Experiences",       url: () => `${getOrgBase()}/lightning/setup/SetupNetworks/home` },
  { label: "Custom Tabs",               url: () => `${getOrgBase()}/lightning/setup/CustomTabs/home` },
  { label: "Report Types",                  url: () => `${getOrgBase()}/lightning/setup/CustomReportTypeLightning/home` },
  { label: "Schema Builder",            url: () => `${getOrgBase()}/lightning/setup/SchemaBuilder/home` },
  { label: "Event Log File Browser",        url: () => `${getOrgBase()}/lightning/setup/ElfBrowser/home` },
  { label: "Case Assignment Rules",     url: () => `${getOrgBase()}/lightning/setup/CaseRules/home` },
  { label: "Case Escalation Rules",         url: () => `${getOrgBase()}/lightning/setup/CaseEscRules/home` },
  { label: "Omni-Channel Settings",     url: () => `${getOrgBase()}/lightning/setup/OmniChannelSettings/home` },
  { label: "Agentforce Agents",         url: () => `${getOrgBase()}/lightning/setup/EinsteinCopilot/home` },
  { label: "Agentforce Assets",         url: () => `${getOrgBase()}/lightning/setup/AgentAssetLibrary/home` },
  { label: "Agentforce Data Library",   url: () => `${getOrgBase()}/lightning/setup/EinsteinDataLibrary/home` },
  { label: "Agentforce Policies",       url: () => `${getOrgBase()}/lightning/setup/AgentforceProtectionPolicies/home` },
  { label: "Setup with Agentforce",         url: () => `${getOrgBase()}/lightning/setup/AgentforceSetup/home` },
  { label: "Agentforce Testing Center", url: () => `${getOrgBase()}/lightning/setup/TestingCenter/home` },
  { label: "Agentforce Agent Analytics", url: () => `${getOrgBase()}/lightning/setup/AgentAnalyticsLibrary/home` },
  { label: "Agentforce Studio",         url: () => `${getOrgBase()}/lightning/n/standard-AgentforceStudio` },
  { label: "Registered MCP Servers",    url: () => `${getOrgBase()}/lightning/setup/AgentforceRegistry/home` },
  { label: "Einstein Trust Layer",      url: () => `${getOrgBase()}/lightning/setup/EinsteinTrustLayerSetup/home` },
  { label: "Einstein Audit and Monitoring", url: () => `${getOrgBase()}/lightning/setup/EinsteinFeedbackSetup/home` },
  { label: "Einstein Setup",            url: () => `${getOrgBase()}/lightning/setup/EinsteinGPTSetup/home` },
  { label: "Einstein Bots",             url: () => `${getOrgBase()}/lightning/setup/EinsteinBots/home` },
  { label: "Einstein Intent Sets",      url: () => `${getOrgBase()}/lightning/setup/EinsteinIntentSets/home` },
  { label: "Einstein Real-Time Translations", url: () => `${getOrgBase()}/lightning/setup/EinsteinConversationTranslate/home` },
  { label: "Einstein.ai Key Management", url: () => `${getOrgBase()}/lightning/setup/EinsteinKeyManagement/home` },
  { label: "Einstein Opt Out",          url: () => `${getOrgBase()}/lightning/setup/EinsteinOptOut/home` },
  { label: "Flow Creation with Einstein", url: () => `${getOrgBase()}/lightning/setup/EinsteinForFlow/home` },
  { label: "Prompt Builder",            url: () => `${getOrgBase()}/lightning/setup/EinsteinPromptStudio/home` },
  { label: "Service AI Grounding",      url: () => `${getOrgBase()}/lightning/setup/EinsteinGPTGrounding/home` },
  { label: "Activity Sync Settings",    url: () => `${getOrgBase()}/lightning/setup/ActivitySyncEngineSettingsMain/home` },
  { label: "Einstein Search Settings",  url: () => `${getOrgBase()}/lightning/setup/EinsteinSearchSettings/home` },
  { label: "Einstein Search Analytics", url: () => `${getOrgBase()}/lightning/setup/SearchAnalytics/home` },
  { label: "Einstein Search Layouts",   url: () => `${getOrgBase()}/lightning/setup/EinsteinSearchLayouts/home` },
  { label: "Promoted Search Terms",     url: () => `${getOrgBase()}/lightning/setup/SearchPromotionRulesManagementPage/home` },
  { label: "Search Query Configurations", url: () => `${getOrgBase()}/lightning/setup/SearchConfiguration/home` },
  { label: "Search Synonyms",           url: () => `${getOrgBase()}/lightning/setup/ManageSynonyms/home` },
  { label: "Search Index Setup",        url: () => `${getOrgBase()}/lightning/setup/SearchIndex/home` },
  { label: "API Registry",              url: () => `${getOrgBase()}/lightning/setup/ApiRegistry/home` },
  { label: "Commerce Agentforce Settings", url: () => `${getOrgBase()}/lightning/setup/CommerceAgentSettings/home` },
  { label: "Agentforce Sales Coach",    url: () => `${getOrgBase()}/lightning/setup/AgentforceSalesCoachGo/home` },
  { label: "Agentforce Lead Nurturing", url: () => `${getOrgBase()}/lightning/setup/EinsteinSdr/home` },
  { label: "Agentforce Vibes Extension", url: () => `${getOrgBase()}/lightning/setup/EinsteinForDevelopers/home` },
  { label: "Agentforce Vibes IDE",      url: () => `${getOrgBase()}/lightning/setup/CodeBuilderSetup/home` },
];
