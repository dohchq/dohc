import { mount } from "../mount";
import WorkspaceApp from "../WorkspaceApp";
import { namedInvitationGrant } from "../namedInvitation";

mount(<WorkspaceApp grantId={namedInvitationGrant(location.pathname, "workspace")} />);
