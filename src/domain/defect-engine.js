/* ============================================================================
   不良判定引擎 —— 规则表 + 判定流水 + 待确认队列
   ----------------------------------------------------------------------------
   对应 RDIMM 的 classifyDefect / recordDefectJudgement。

   三态结论（VERDICT）：
     functional    功能性不良 → 写不良记录且自动 confirmed=true
     nonfunctional 非功能性   → 只留流水，不写不良记录（机柜侧事件等）
     unknown       待确认     → 写不良记录但 confirmed=false，等人工确认

   设计要点（沿用 RDIMM 并被其源码解析肯定的做法）：
     · 规则按 priority 升序，首个命中即返回
     · 每次判定都写流水（不可变审计），可回溯原文、命中规则、确认人
     · 规则变更只影响后续判定，**不重算历史** —— 这是有意为之
   ============================================================================ */

const DefectEngine = (() => {

  /* 首次使用时把内置规则展开为完整规则对象 */
  function ensureRules(cfg) {
    if (!cfg.defectRules || !cfg.defectRules.length) {
      cfg.defectRules = DEFAULT_DEFECT_RULES.map((x, i) => ({
        id: 'dr_' + Util.uid('r'),
        priority: (i + 1) * 10,
        enabled: true,
        matchType: x[0],
        pattern: x[1],
        verdict: x[2],
        defectType: x[3],
        note: '内置规则',
        hitCount: 0,
        createdAt: Util.nowStr(),
        updatedAt: Util.nowStr()
      }));
    }
    return cfg.defectRules;
  }

  function rules(cfg) { return ensureRules(cfg); }

  function sortedEnabled(cfg) {
    return rules(cfg).filter(r => r.enabled)
      .slice()
      .sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  /* --------------------------------------------------------------------------
     核心判定：首个命中即返回
     返回 { verdict, defectType, ruleId, confidence }
       confidence: 'rule' 命中规则 | 'none' 未命中（进待确认）
     -------------------------------------------------------------------------- */
  function classify(cfg, rawText, errCode, station) {
    const txt = String(rawText || '');
    const list = sortedEnabled(cfg);

    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const p = String(r.pattern || '');
      let hit = false;

      if (r.matchType === 'errcode') {
        hit = !!errCode && String(errCode).toUpperCase() === p.toUpperCase();
      } else if (r.matchType === 'station') {
        hit = !!station && String(station).toUpperCase().indexOf(p.toUpperCase()) >= 0;
      } else if (r.matchType === 'keyword') {
        if (!p) hit = false;                      // 空关键词不参与匹配，防止误命中
        else if (/^\/.*\/$/.test(p)) {            // /正则/ 形式
          try { hit = new RegExp(p.slice(1, -1), 'i').test(txt); } catch (e) { hit = false; }
        } else {
          hit = txt.toUpperCase().indexOf(p.toUpperCase()) >= 0;
        }
      } else if (r.matchType === 'any') {
        hit = true;                               // 兜底
      }

      if (hit) {
        r.hitCount = (r.hitCount || 0) + 1;
        r.updatedAt = Util.nowStr();
        return {
          verdict: r.verdict || 'unknown',
          defectType: r.defectType || p || '未分类',
          ruleId: r.id,
          confidence: 'rule',
          rule: r
        };
      }
    }
    return { verdict: 'unknown', defectType: '待确认', ruleId: '', confidence: 'none', rule: null };
  }

  /* 试判定：不动命中计数，供「不良判定设置」界面预览用 */
  function dryRun(cfg, rawText, errCode, station) {
    const list = sortedEnabled(cfg);
    const txt = String(rawText || '');
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const p = String(r.pattern || '');
      let hit = false;
      if (r.matchType === 'errcode') hit = !!errCode && String(errCode).toUpperCase() === p.toUpperCase();
      else if (r.matchType === 'station') hit = !!station && String(station).toUpperCase().indexOf(p.toUpperCase()) >= 0;
      else if (r.matchType === 'keyword') {
        if (p) {
          if (/^\/.*\/$/.test(p)) { try { hit = new RegExp(p.slice(1, -1), 'i').test(txt); } catch (e) { } }
          else hit = txt.toUpperCase().indexOf(p.toUpperCase()) >= 0;
        }
      } else if (r.matchType === 'any') hit = true;
      if (hit) return { verdict: r.verdict, defectType: r.defectType, ruleId: r.id, confidence: 'rule', rule: r };
    }
    return { verdict: 'unknown', defectType: '待确认', ruleId: '', confidence: 'none', rule: null };
  }

  /* --------------------------------------------------------------------------
     记录判定：写流水 + 按需写不良记录
     ctx: { source, rawText, errCode, station, sn, pn, model, woNo,
            cabinetId, serverId, slotIndex, boxId, time, note }
     返回 { judgementId, badId, verdict, defectType, ruleId, confidence }
     -------------------------------------------------------------------------- */
  async function record(ctx, deps) {
    const cfg = deps.cfg;
    const c = ctx || {};
    const raw = String(c.rawText || c.note || c.type || '');
    const code = c.errCode || ErrCodeRules.extract(raw) || '';
    const j = classify(cfg, raw, code, c.station || '');
    const v = VERDICT[j.verdict] || VERDICT.unknown;
    const day = c.day || Util.todayKey(new Date(c.time || Date.now()));

    const judgementId = Util.uid('jdg');
    let badId = '';

    /* --- 写不良记录 ---
       非功能性不良（如机柜侧事件）不进不良表，只留流水 */
    if (v.toBad && c.sn) {
      // 去重键：工站 + 位置 + SN + 日期（同一块盘同一天同一站只留一条）
      const existing = (await deps.findBad(c)).filter(b =>
        b.sn === c.sn && b.station === (c.station || '') &&
        b.day === day &&
        String(b.slotIndex == null ? '' : b.slotIndex) === String(c.slotIndex == null ? '' : c.slotIndex)
      )[0];

      if (existing) {
        badId = existing.id;
        existing.verdict = j.verdict;
        existing.errCode = code;
        existing.type = j.defectType;
        existing.judgementId = judgementId;
        // 已人工确认过的不被自动判定覆盖
        if (existing.confirmedBy) {
          existing.confirmed = true;
        } else {
          existing.confirmed = v.autoConfirm;
        }
        existing.updatedAt = Date.now();
        await deps.saveBad(existing);
      } else {
        const bad = Schema.newBad({
          day, time: c.time || Date.now(),
          station: c.station || '', cabinetId: c.cabinetId || '',
          serverId: c.serverId || '', slotIndex: c.slotIndex,
          boxId: c.boxId || '',
          sn: c.sn, pn: c.pn || '', model: c.model || '', woNo: c.woNo || '',
          type: j.defectType, errCode: code, verdict: j.verdict,
          confirmed: v.autoConfirm,
          judgementId, note: c.note || raw, source: c.source || 'manual'
        });
        badId = bad.id;
        await deps.saveBad(bad);
      }
    }

    /* --- 写流水（不可变审计，只增不改） --- */
    const jdg = Schema.newJudgement({
      id: judgementId,
      at: c.time || Date.now(),
      source: c.source || 'manual',
      rawText: raw, errCode: code, station: c.station || '',
      cabinetId: c.cabinetId || '', slotIndex: c.slotIndex,
      sn: c.sn || '', verdict: j.verdict, ruleId: j.ruleId,
      confidence: j.confidence,
      confirmed: j.verdict === 'functional',
      badId
    });
    await deps.saveJudgement(jdg);

    return {
      judgementId, badId,
      verdict: j.verdict, defectType: j.defectType,
      ruleId: j.ruleId, confidence: j.confidence
    };
  }

  /* --------------------------------------------------------------------------
     待确认队列
     -------------------------------------------------------------------------- */
  async function pending(deps, limit) {
    const list = await deps.listBad({ confirmed: false }, { desc: true, limit: limit || 500 });
    return list;
  }

  /* 批量确认 */
  async function confirm(ids, by, note, deps) {
    const arr = Array.isArray(ids) ? ids : [ids];
    let n = 0;
    for (const id of arr) {
      const b = await deps.getBad(id);
      if (!b || b.confirmed) continue;
      b.confirmed = true;
      b.confirmedBy = by || '';
      b.confirmedAt = Date.now();
      if (note) b.note = (b.note ? b.note + ' | ' : '') + note;
      b.updatedAt = Date.now();
      await deps.saveBad(b);
      // 同步回填流水
      if (b.judgementId) {
        const j = await deps.getJudgement(b.judgementId);
        if (j) {
          j.confirmed = true; j.confirmedBy = by || '';
          j.confirmedAt = Date.now(); j.confirmNote = note || '';
          await deps.saveJudgement(j);
        }
      }
      n++;
    }
    return n;
  }

  /* 规则 CRUD */
  function addRule(cfg, r) {
    const rule = {
      id: 'dr_' + Util.uid('r'),
      priority: r.priority != null ? Number(r.priority) : (rules(cfg).length + 1) * 10,
      enabled: r.enabled !== false,
      matchType: r.matchType || 'keyword',
      pattern: r.pattern || '',
      verdict: r.verdict || 'unknown',
      defectType: r.defectType || '',
      note: r.note || '',
      hitCount: 0,
      createdAt: Util.nowStr(),
      updatedAt: Util.nowStr()
    };
    cfg.defectRules.push(rule);
    return rule;
  }
  function updateRule(cfg, id, patch) {
    const r = rules(cfg).filter(x => x.id === id)[0];
    if (!r) return null;
    Object.assign(r, patch, { updatedAt: Util.nowStr() });
    return r;
  }
  function removeRule(cfg, id) {
    const i = cfg.defectRules.findIndex(x => x.id === id);
    if (i < 0) return false;
    cfg.defectRules.splice(i, 1);
    return true;
  }
  function resetRules(cfg) {
    cfg.defectRules = [];
    ensureRules(cfg);
    return cfg.defectRules;
  }
  /* 仅停用/启用，不删除 */
  function toggleRule(cfg, id, on) {
    const r = cfg.defectRules.filter(x => x.id === id)[0];
    if (!r) return null;
    r.enabled = (on === undefined) ? !r.enabled : !!on;
    r.updatedAt = Util.nowStr();
    return r;
  }

  /* 命中统计（用于规则管理界面排序展示） */
  function hitStats(cfg) {
    return rules(cfg)
      .slice()
      .sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0))
      .map(r => ({ id: r.id, pattern: r.pattern, matchType: r.matchType,
                   verdict: r.verdict, hits: r.hitCount || 0, enabled: r.enabled }));
  }

  return {
    ensureRules, rules, sortedEnabled,
    classify, dryRun, record,
    pending, confirm,
    addRule, updateRule, removeRule, resetRules, toggleRule, hitStats
  };
})();
