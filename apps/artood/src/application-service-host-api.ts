// This module is the bootstrap's only delayed application entry. Package it in
// the same splitting build so its admission modules retain the original WeakMaps.
export { reopenInstalledApplicationService } from "./application-installed-session.js";
export { initializeApplicationPackage } from "./application-initialize-package.js";
