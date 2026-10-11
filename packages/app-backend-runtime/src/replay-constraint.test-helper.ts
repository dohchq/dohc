import {fileURLToPath} from 'node:url';
import type {AppRuntimeLauncher} from './protocol.ts';

// This wrapper runs only in a test-owned worker. All replay and rebuild work remains real.
export function replayConstraintLauncher(launch:AppRuntimeLauncher,revision:number):AppRuntimeLauncher {
  return options=>launch({...options,
    entryPath:fileURLToPath(new URL('./replay-constraint-worker.test-helper.mjs',import.meta.url)),
    env:{...options.env,DOHC_TEST_REPLAY_ENTRY:options.entryPath,DOHC_TEST_REPLAY_REVISION:String(revision)},
  });
}
