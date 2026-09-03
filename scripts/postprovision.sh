#!/bin/sh
# Runs after `azd up` provisions on a POSIX shell. Kept for completeness — the
# supported path is scripts/Deploy-Cortex.ps1 from PowerShell 7, which also
# onboards the APIM key, switches on sign-in with the groups claim, grants the
# Cortex identity its Purview roles and creates the content.
set -e

echo ""
echo "======================================================================"
echo " Cortex provisioned."
echo "======================================================================"
echo ""
echo " Web app:  ${CORTEX_WEB_URL}"
echo " MCP:      ${CORTEX_MCP_URL}"
echo ""
echo " Three steps remain, all scripted:"
echo ""
echo " 1. APIM subscription key onto the app"
echo "      pwsh ./scripts/Deploy-Cortex.ps1 -SkipProvision -SkipBootstrap -SkipAuth -SkipHealthCheck"
echo " 2. Entra sign-in, WITH the groups claim"
echo "      pwsh ./scripts/Set-CortexAuth.ps1"
echo " 3. Purview access for the Cortex identity (${CORTEX_IDENTITY_PRINCIPAL_ID}) and the content"
echo "      . ./scripts/Set-CortexEnv.ps1   (dot-sourced, in pwsh)"
echo "      npm run bootstrap"
echo ""
echo " Then verify:"
echo "    curl ${CORTEX_WEB_URL}/api/health"
echo ""
