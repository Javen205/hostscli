import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    crud: 'src/engine/crud.ts',
    ttl: 'src/engine/ttl.ts',
    duration: 'src/ttl/duration.ts',
    profiles: 'src/engine/profiles.ts',
    backup: 'src/engine/backup-service.ts',
    config: 'src/engine/config-service.ts',
    stack: 'src/engine/stack.ts',
    network: 'src/engine/network.ts',
    git: 'src/engine/git.ts',
    export: 'src/engine/export.ts',
    audit: 'src/engine/audit.ts',
    undo: 'src/engine/undo.ts',
    run: 'src/engine/run.ts',
    remote: 'src/remote/service.ts',
    doctor: 'src/diagnostics/doctor.ts',
    system: 'src/entries/system.ts',
    storage: 'src/storage/paths.ts',
  },
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
});
