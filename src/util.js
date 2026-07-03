/** 无依赖的小工具。 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
