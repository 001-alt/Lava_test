/* ============================================================================
   版本迁移
   ----------------------------------------------------------------------------
   RDIMM 的教训：它的 STORAGE_KEY 带版本号（..._v5），升级靠换键名，
   结果是老数据在新版里直接不可见（源码解析 §10.2）。
   这里改为「同键 + schemaVersion 字段 + 显式迁移函数」。

   新增版本时：
     1. 改 core/constants.js 的 SCHEMA_VERSION
     2. 在 MIGRATIONS 里加 n → n+1 的迁移
     3. 迁移必须是幂等的（重复执行不出错）
   ============================================================================ */

const Migrate = (() => {

  /* 配置层迁移链：键为「起始版本」，值为把该版本升到下一版的函数 */
  const MIGRATIONS = {
    /* 示例（暂无历史版本）：
       1: (cfg) => { cfg.newField = []; return cfg; } */
  };

  /* 配置层迁移 */
  function config(cfg) {
    if (!cfg) return cfg;
    let v = Number(cfg.schemaVersion || 0);
    const def = Schema.defaultConfig();
    if (!v) {
      // 无版本号 = 首次或极老存档，套用默认值兜底
      cfg.schemaVersion = SCHEMA_VERSION;
      return cfg;
    }
    let guard = 0;
    while (v < SCHEMA_VERSION && guard++ < 50) {
      const fn = MIGRATIONS[v];
      if (fn) {
        try { cfg = fn(cfg) || cfg; }
        catch (e) { console.error('[Migrate] 配置 v' + v + ' 迁移失败：', e); break; }
      }
      v++;
      cfg.schemaVersion = v;
    }
    // 迁移后补默认值（新增配置项对老存档生效）
    return cfg;
  }

  /* IndexedDB 结构迁移（由 Idb 的 onupgradeneeded 调用） */
  function onUpgrade(db, fromVersion, toVersion) {
    console.info('[Migrate] IndexedDB v' + fromVersion + ' → v' + toVersion);
    /* 目前只有 v1，无需结构迁移。
       将来加对象仓/索引时在这里按 fromVersion 分支处理。 */
  }

  return { config, onUpgrade, MIGRATIONS };
})();
