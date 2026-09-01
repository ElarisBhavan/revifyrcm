/* ReviFlow runtime configuration.
   This one line is what switches the app from "local" (every browser keeps
   its own private, empty copy of the data — fine for building and testing)
   to "api" (everyone shares the real database on the server). Every page
   loads this before _store.js, so it has to exist at the SITE ROOT, right
   next to reviflow.html — pages one folder down (Patient/, Provider/) reach
   it as "../_config.js".

   If this file is ever missing, nothing throws an error — the app just
   quietly falls back to the empty local mode, which looks exactly like all
   the patients and claims disappeared even though the real database is
   completely untouched. */
window.RF_CONFIG = { driver: 'api' };
