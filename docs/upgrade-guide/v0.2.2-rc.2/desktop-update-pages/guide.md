---
kind: upgrade-guide
description: Unsigned Desktop packages require published GitHub Pages channel manifests instead of querying the GitHub Releases API.
---

# Desktop update manifests on GitHub Pages

English | [中文](guide.zh.md)

## Change

Unsigned Desktop packages configured with `dshDesktopManualUpdateRepository` check static Pages manifests instead of the GitHub Releases REST API. Repository maintainers must deploy both channel files before distributing the updated client. The client rejects missing, invalid, or mismatched metadata instead of reporting that the installed version is current. Installation continues through the GitHub Release page.

## Migration

1. Follow [GitHub Release automation](../../../../apps/desktop/packaging/README.md#github-release-automation) to reserve the repository's default Pages site and enable Actions deployment.
2. Run **Deploy GitHub Pages** with `site=desktop-updates` from the updated source. Verify `updates/stable.json` and `updates/nightly.json` are reachable; the development manifest must include an uploaded compatible installer.
3. Distribute a client containing this change. Existing installations need one manual upgrade because they retain the API-based checker. Later `desktop-v<version>` releases publish manifests after installer upload succeeds; refresh them manually after editing or deleting an existing Release.
