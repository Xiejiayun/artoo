# Windows process host

This fixed helper implements `artoo.windows-job-process.v1`. Keep target output separate from control frames and retain the atomic Job membership, exact process HANDLE wait, pipe EOF and Job-zero requirements. A successful build alone does not qualify Windows autonomous execution or publication.

Build on native x64 Windows with a stable .NET 10 SDK:

```powershell
npm run build:windows-process-host --workspace @artoo/artood
```

The source is this directory. The default complete bundle is `apps/artood/native-dist/windows-process-host`; its SDK intermediate files remain under the ignored `apps/artood/native-dist/.build` directory. The build always produces a self-contained `win-x64` host, so installed users do not need the .NET SDK or runtime.

The destination must be new. To preserve an existing bundle, choose a new output directory:

```powershell
npm run build:windows-process-host --workspace @artoo/artood -- --out-dir C:\artoo-builds\windows-process-host-next
```

`manifest.json` uses version 1 and binds every published file by canonical relative path, byte size and SHA-256. It is published last, after successful SDK exit/close and complete bundle inspection. The final JSON output includes the manifest SHA-256 for a separate local installation record. A failed build may retain partial binaries and intermediate files, but must not publish a usable manifest. Do not copy a manifest from another build to make partial output loadable.

Verify packaging with this actual build and the native process fixtures against the exact compiled module and separately recorded manifest hash. Production installation ACLs, qualified profiles, real CLI/browser compatibility, signing/distribution and product publication are separate gates; this command enables none of them and does not replace the ordinary TypeScript build.
