// Registers the .tsx hooks; import this before dynamically importing a .tsx module.
import { register } from "node:module";

register("./tsx-hooks.mjs", import.meta.url);
