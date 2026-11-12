import "../join.css";
import { mount } from "../mount";
import JoinApp, { takeJoinToken } from "../JoinApp";

mount(<JoinApp token={takeJoinToken()} />);
