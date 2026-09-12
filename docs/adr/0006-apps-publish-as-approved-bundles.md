# Apps publish as owner-approved immutable bundles

An app's manifest is a request, not a boundary: source can ask for authority, and only the owner can confer it. Serving an app to link holders therefore goes through a **publication**: an immutable, content-addressed bundle tied to a source revision, dependency lock, manifest digest, and explicit owner approval. A source, dependency, or manifest change creates a new unpublished revision; nothing publishes automatically. A missing manifest requests no capabilities; a malformed manifest fails publication rather than falling back to static serving.

The effective dohc authority an app receives is the intersection of the pinned publication's requests, the owner's approval, the active link grant, and server policy. An app receives no workspace authority or dohc credentials from its execution environment. An app that requests no dohc capabilities is still untrusted code and runs in an isolated browser context on its own origin.

Published apps use ordinary browser networking, subject to browser rules and the publication's script, embedding, and browser-permission controls. External networking is not a separately approved dohc capability. Apps may send approved data, user-entered responses, and visitor information to third parties. Approval means the owner trusts the approved revision with the selected data and operations. It is not a promise that dohc has certified the app's behavior.

Before approval, the owner sees which data and operations the app receives and that the app may send received data elsewhere. Before launch, the recipient sees that the app can contact other sites and that the viewer's remote-media privacy guarantee does not apply. Unpublishing refuses new launches and subsequent protected app reads and writes. Revoking or narrowing a capability stops subsequent unauthorized dohc reads and writes at the server's authority check. These actions cannot recall received data or guarantee that a loaded app stops external traffic. The interface may close an embedded app after withdrawal without presenting closure as network enforcement.

The publication pins the executable bundle. Remote script and module loading remain blocked; dependencies must be included in the approved build. This constrains browser script loading, not every possible use of fetched data by approved code. Credential isolation, origin isolation, selector containment, server authorization, and abuse budgets remain mandatory with external networking enabled.

## Why networking is not a dohc capability

The earlier design promised that an app could read shared data while dohc prevented it from sending that data elsewhere. Browser probes found a WebRTC path around the proposed wrapper. Other proposed network restrictions remained unproven or experimental. A custom rendering framework or hosted browser would impose substantial compatibility or deployment costs to enforce that promise.

On September 12, 2026, the owner chose to reconsider that promise in favor of the ordinary web-app trust model. The revised boundary protects data and authority an app was never granted. It does not guarantee how an app uses data it receives. Ordinary React and React DOM remain the implementation direction; a custom dohc UI framework is not required. The owner-approved revision and scoped data API remain essential. Existing browser-feature restrictions need their own review and are not removed by this decision.

## Builds remain a separate trust boundary

Builds are part of the trust boundary: Vite runs arbitrary code at build time through config, plugins, and dependency hooks, so builds never run inside `share-web`. The build trust model (owner builds locally, a fixed no-plugin compiler, or an isolated credential-free builder) is chosen when the app phase is planned. The local option is acceptable only sandboxed — credential-free, network-denied, limited to declared build inputs — because in a shared workspace, building app source someone else edited is running their code with the owner's authority.

## Phase boundary

Phase 2 proves isolation for the viewer origin, including active formats, navigation, remote fetches, service workers, storage, cross-origin requests, and viewer credentials. It does not stand in for app isolation. Phase 5 reruns the app-origin and cross-app storage attacks against the publication model on a separate registrable domain.
