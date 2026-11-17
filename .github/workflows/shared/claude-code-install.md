---
description: Install the pinned Claude Code binary for Linux runners.
steps:
  - name: Install verified Claude Code
    run: |
      # Claude Code 2.1.317, linux-x64. SHA-256 from the signed Anthropic manifest.
      curl --fail --silent --show-error --location --max-time 120 \
        'https://downloads.claude.ai/claude-code-releases/2.1.317/linux-x64/claude' \
        --output /tmp/gh-aw/claude
      printf '%s  %s\n' \
        eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0 \
        /tmp/gh-aw/claude | sha256sum --check
      chmod 0755 /tmp/gh-aw/claude
---
