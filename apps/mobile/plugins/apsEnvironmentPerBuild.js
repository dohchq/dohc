// The entitlement reads the build setting, so Xcode signs Debug for APNs development and Release for production.
const { withEntitlementsPlist, withXcodeProject } = require("expo/config-plugins");

module.exports = function apsEnvironmentPerBuild(config) {
  config = withEntitlementsPlist(config, (entitlements) => {
    entitlements.modResults["aps-environment"] = "$(DOHC_APS_ENVIRONMENT)";
    return entitlements;
  });
  return withXcodeProject(config, (project) => {
    for (const entry of Object.values(project.modResults.pbxXCBuildConfigurationSection())) {
      if (typeof entry !== "object" || !entry.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER) continue;
      entry.buildSettings.DOHC_APS_ENVIRONMENT =
        entry.name === "Release" ? "production" : "development";
    }
    return project;
  });
};
