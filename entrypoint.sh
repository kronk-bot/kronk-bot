#!/bin/bash
set -e

# Create runtime config directories
mkdir -p /data/pi-config /data/workspace

# Write settings.json so the pi SDK knows the default provider
# (we override the model at runtime, but settings.json must exist)
cat > /data/pi-config/settings.json <<EOF
{
  "defaultProvider": "openrouter",
  "defaultModel": "${OPENROUTER_MODEL:-minimax/minimax-m2.5}"
}
EOF

# auth.json is left empty — API keys are injected at runtime via
# AuthStorage.setRuntimeApiKey() in the application code, so nothing
# sensitive is written to disk here.
touch /data/pi-config/auth.json

exec "$@"
