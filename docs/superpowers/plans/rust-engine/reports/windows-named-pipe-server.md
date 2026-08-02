# Windows CLI named-pipe server report

## What changed

- Replaced the Windows platform refusal in `apps/desktop/src/cli/cliServer.ts` with a real Node `net` named-pipe listener.
- Each server boot now generates a 128-bit random pipe-name suffix and listens at `\\.\pipe\dohc-cli-<32 hex chars>`.
- Added the `dohc-cli-endpoint` descriptor in the CLI state directory. On Windows it contains the complete pipe name, so discovery can read the name back instead of deriving it from `stateDir`.
- Windows startup, failure cleanup, and shutdown remove the endpoint descriptor instead of trying to remove the named pipe as a filesystem socket. POSIX continues to remove `dohc-cli.sock`.
- The POSIX socket is still chmodded to `0600`; Windows skips that inapplicable socket chmod. The state-directory, token-file, and descriptor-file mode sites now explicitly document that Node modes/chmod do not establish Windows ACLs.
- Preserved the existing NDJSON handler and protocol version, 64-connection limit, 15-second request deadline, 1 MiB line limit, one request per connection, `server.unref()`, and in-flight drain during close.
- Did not change `packages/cli`, `packages/workspace-engine`, or `CLI_PROTOCOL_VERSION`.

## Tests

Named transport/security tests:

- `CLI socket server > rejects a wrong token over the live transport before request parsing`
- `CLI socket server > writes a random capability endpoint descriptor for a Windows named pipe`

The suite now supplies `process.platform`. On Windows all CLI request/response coverage therefore connects to the real named pipe; it no longer forces an AF_UNIX path and no longer accepts the resulting `EACCES` as a fallback. The POSIX mode-bit test is the one CLI-suite skip on Windows because those mode assertions do not describe Windows ACLs.

Validation results:

- `pnpm --filter @dohc/desktop exec vitest run src/cli/cliServer.test.ts`: 19 passed, 1 Windows-inapplicable POSIX permission test skipped.
- `pnpm --filter @dohc/desktop typecheck`: passed.
- `pnpm --filter @dohc/desktop test`: 170 files passed; 2,145 tests passed and 3 skipped. The load-sensitive `collectZipEntries` timeout did not occur.
- `git diff --check`: passed.

## Authentication mutation proof

I temporarily changed `tokenMatches` to always return `true` and ran only `CLI socket server > rejects a wrong token over the live transport before request parsing`.

The test failed as intended: the same valid named-pipe connection with a wrong token reached request parsing and returned `dohc: invalid CLI request` instead of the expected `dohc: CLI authentication failed`. This proves the named test detects bypass of the pre-parse token gate. I restored the original 64-hex validation and `timingSafeEqual` comparison, reran the named test, and it passed.

## Residual Windows named-pipe security posture

The Windows named pipe is weaker than a Unix socket protected by a `0700` directory and `0600` socket mode. Node/libuv does not expose a security-attributes seam here, so the pipe uses the default Windows DACL; it is not owner-only, and other local OS users can receive the access granted by that default DACL. Anyone who learns or guesses the pipe name can attempt a connection.

The fresh 128-bit random pipe-name suffix on every boot is not a mitigation, and it is not a capability. The `\\.\pipe\` namespace is enumerable: any local process can list it and read the current name without opening the CLI state directory, and any local process can create a pipe whose name matches the same pattern. The mitigation is the independent 256-bit request token alone. Every request must pass the token check before protocol-version or request-schema parsing. Both values are stored under the CLI state directory, so the token's confidentiality rests entirely on that directory's ACL.

On Windows, the `0700`/`0600` mode arguments and `chmod` calls do not create a protective DACL. Confidentiality of both `dohc-cli-endpoint` and `dohc-cli-token` depends entirely on the inherited ACL of `%APPDATA%\dohc`. If another OS user can read that directory, that user can obtain both the pipe name and the authentication token and can issue authenticated CLI requests. The random name does not protect against that case, and an enumerable namespace means it does not protect against the weaker case of a local process that cannot read the directory either. This residual gap does not exist in the same form when the POSIX state directory and socket are actually enforced as owner-only by `0700`/`0600` permissions.

## The client half (#333)

`packages/cli/src/client.ts` refused win32 in both `locateCliEndpoint` and `sendCliRequest`, so nothing could reach the pipe the server had been serving. Discovery now selects the artifact by platform: `dohc-cli.sock` on POSIX, `dohc-cli-endpoint` on Windows. A Windows state dir counts as live only when the token file is readable and the descriptor holds a name matching `\\.\pipe\dohc-cli-<32+ hex>`; the client dials that name and sends the boot token exactly as it does over a Unix socket.

The pattern match is not decoration, but its value is narrower than a name check looks. The name proves nothing about the listener: any local process can enumerate `\\.\pipe\`, and any local process can create a pipe called `dohc-cli-<32 hex>`. What the pattern does enforce is that the endpoint is local. The descriptor is a file, and the client sends the token to whatever it names. Without the check, anyone who could write the descriptor could name `\\attacker-host\pipe\dohc-cli-…` and the CLI would carry the token off the machine over SMB. The pattern refuses every `\\host\pipe\...` form, so a rewritten descriptor can only redirect to a pipe on this machine — where the writer already needed read access to the state dir, which yields the token directly.

`locateCliEndpoint` throws `desktop app not running` on Windows when nothing resolves. A dead Unix path is still nameable, so that case keeps returning the preferred endpoint and lets the connection report the failure; a pipe name is not derivable, so there is nothing honest to return.

Authorization is unchanged and identical on both platforms: the 64-hex boot token, compared with `timingSafeEqual` before version and schema parsing. The difference remains the one recorded above — a `0600` Unix socket denies the connection, the pipe denies only the request.
