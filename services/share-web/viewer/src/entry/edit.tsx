import { mount } from "../mount";
import NamedRecipientApp from "../NamedRecipientApp";
import { namedInvitationGrant } from "../namedInvitation";

mount(<NamedRecipientApp grantId={namedInvitationGrant(location.pathname, "edit")} />);
