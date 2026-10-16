import { mount } from "../mount";
import NamedChatApp from "../NamedChatApp";
import { namedInvitationGrant } from "../namedInvitation";

mount(<NamedChatApp grantId={namedInvitationGrant(location.pathname, "chat")} />);
