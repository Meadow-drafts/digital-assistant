ABANKING_CODE_BUNDLE_ID: "IWOMIAgencyBankingFrontOffice",

cd /Users/meadow/Documents/GitHub/iwomi/assistant

ASSISTANT_PROFILE=agency-banking \
ASSISTANT_TENANT_ID=iwomi-agency \
AGENCY_GATEWAY_BASE_URL=http://148.113.191.174:8765 \
ALLOWED_ORIGINS=http://localhost:3001 \
PORT=3002 \
npm start



cd /Users/meadow/Documents/GitHub/iwomi/agency-banking-front-office

PORT=3001 REACT_APP_ASSISTANT_URL_IWOMI=http://localhost:3002 npm start