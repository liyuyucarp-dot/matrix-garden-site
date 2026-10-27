  // [[courtyard:services]] 后台任务服务钩子（2026-10-24）：核心服务交给"后台任务型"技能。
  // 来源：skills/travel-whale/CORE-PATCH.md —— 纯新增，不改任何既有行为。
  setServices(services) {
    this.serviceListeners = this.serviceListeners || new Set();
    this.servicesRef = services && typeof services === 'object' ? services : null;
    for (const fn of this.serviceListeners) {
      try { fn(this.servicesRef); } catch (error) { this.#warn('core', 'services 监听器失败', error); }
    }
    return this.servicesRef;
  }

  get services() { return this.servicesRef || null; }

  /** 注册「核心服务就绪」回调；已就绪会立即回调一次。返回取消函数。 */
  onServices(fn) {
    this.serviceListeners = this.serviceListeners || new Set();
    if (typeof fn !== 'function') return () => {};
    this.serviceListeners.add(fn);
    if (this.servicesRef) {
      try { fn(this.servicesRef); } catch (error) { this.#warn('core', 'services 监听器失败', error); }
    }
    return () => this.serviceListeners.delete(fn);
  }

