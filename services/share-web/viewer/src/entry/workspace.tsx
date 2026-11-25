import { mount } from "../mount";
import WorkspaceApp from "../WorkspaceApp";
import { workspaceTarget } from "../workspaceTarget";

mount(<WorkspaceApp target={workspaceTarget(location.pathname)} />);
