#!/bin/bash
# apiKeyHelper for claude-lanes.
#
# When ANTHROPIC_BASE_URL points at the local router (127.0.0.1), pick by mode:
#   - team leader (CLAUDE_TEAM_ROLE=leader)            → "leader-token"
#   - team teammate (CLAUDE_TEAM_ROLE filtered out)    → "teammate-token"
#   - protocol mode (CLAUDE_PROTOCOL set)              → real CLAUDE_AUTH_TOKEN
# Otherwise (direct connection to a remote provider)   → real token.

if [[ "$ANTHROPIC_BASE_URL" == *"127.0.0.1"* ]]; then
    if [[ "$CLAUDE_TEAM_ROLE" == "leader" ]]; then
        echo "leader-token"
    elif [[ -n "$CLAUDE_PROTOCOL" ]]; then
        # protocol mode: pass the real token through; the router forwards it upstream
        echo "$CLAUDE_AUTH_TOKEN"
    else
        echo "teammate-token"
    fi
else
    echo "$CLAUDE_AUTH_TOKEN"
fi
