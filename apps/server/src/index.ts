import "./upgrade-backup.js";
import { appVersion, config } from "./config.js";
import { hubOptionsFrom, startHub } from "./app.js";

startHub(hubOptionsFrom(config, appVersion, process.env));
