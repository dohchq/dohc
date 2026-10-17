import { mount } from "../mount";
import NamedApp from "../NamedApp";
import { namedAppTarget } from "../namedAppRoute";

mount(<NamedApp target={namedAppTarget(location.pathname)} />);
