/* ============================================================================
   事件总线 —— 解耦「数据变更」与「视图刷新」
   ----------------------------------------------------------------------------
   数据层写完库后 emit 一个事件，视图层订阅自己关心的事件即可，
   不需要让 store 反过来知道有哪些视图存在。
   ============================================================================ */

const Bus = (() => {
  const handlers = {};

  function on(evt, fn) {
    (handlers[evt] = handlers[evt] || []).push(fn);
    return () => off(evt, fn);        // 返回取消订阅函数
  }
  function off(evt, fn) {
    const list = handlers[evt];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  function once(evt, fn) {
    const un = on(evt, function (...args) {
      un();
      fn.apply(null, args);
    });
    return un;
  }
  function emit(evt, payload) {
    const list = handlers[evt];
    if (!list || !list.length) return;
    // 复制一份再遍历：允许回调里取消订阅
    list.slice().forEach(fn => {
      try { fn(payload); }
      catch (e) { console.error('[Bus] 处理 ' + evt + ' 时出错：', e); }
    });
  }
  function clear(evt) {
    if (evt) delete handlers[evt];
    else for (const k in handlers) delete handlers[k];
  }

  return { on, off, once, emit, clear };
})();

/* 事件名常量 —— 避免各模块手写字符串拼错 */
const EVT = {
  SLOTS_CHANGED:   'slots:changed',      // 盘位状态变更（payload: {keys:[...]} 或 {all:true}）
  RECORDS_CHANGED: 'records:changed',    // 测试/不良/报错/判定流水变更
  WO_CHANGED:      'wo:changed',         // 工单变更
  CONFIG_CHANGED:  'config:changed',     // 配置层变更（规则/设置）
  DATA_LOADED:     'data:loaded',        // 一次批量入库完成
  VIEW_SWITCH:     'view:switch',        // 视图切换（payload: viewKey）
  TOAST:           'ui:toast'            // 请求弹提示（payload: {type,msg}）
};
