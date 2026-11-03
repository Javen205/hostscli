/** 面向 CLI 的轻量系统入口：只加载平台路径与 DNS 刷新，不牵出其余 engine。 */
export { currentPlatformId, resolveHostsPath } from '../system/platform';
export { flushDns } from '../system/dns-flush';
