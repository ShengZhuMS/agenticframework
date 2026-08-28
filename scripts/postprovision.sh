#!/bin/sh
# Runs after `azd up` provisions. Two things it CANNOT do, by design:
#   - assign Purview governance roles (portal-only, and tenant-level role
#     groups do not accept service principals at all)
#   - create the Entra app registration for sign-in
# Both are documented as manual steps in the deployment guide.
set -e

echo ""
echo "======================================================================"
echo " Cortex provisioned."
echo "======================================================================"
echo ""
echo " Web app:  ${CORTEX_WEB_URL}"
echo ""
echo " TWO MANUAL STEPS REMAIN — see docs section 4 and 5:"
echo ""
echo " 1. Purview roles (portal only)."
echo "    Identity principal ID: ${CORTEX_IDENTITY_PRINCIPAL_ID}"
echo "    Purview portal > Unified Catalog > Catalog management >"
echo "      Governance domains > [domain] > Roles"
echo "        add as Data Product Owner AND Governance Domain Reader"
echo "    Purview portal > Data Map > Domains and collections > [collection]"
echo "      > Role assignments"
echo "        add as Data reader"
echo ""
echo "    BOTH PLANES ARE REQUIRED. A Data Product Owner without Data Map"
echo "    read cannot see the underlying assets — they silently vanish,"
echo "    including from search. This is the most common setup mistake."
echo ""
echo " 2. Entra sign-in. Skip entirely if demoing with DEMO_MODE=true."
echo ""
echo " Then verify:"
echo "    curl \${CORTEX_WEB_URL}/api/health"
echo ""
