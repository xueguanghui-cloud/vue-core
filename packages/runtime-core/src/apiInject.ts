import { isFunction } from '@vue/shared'
import { currentInstance } from './component'
import { currentRenderingInstance } from './componentRenderContext'
import { currentApp } from './apiCreateApp'
import { warn } from './warning'

interface InjectionConstraint<T> {}

export type InjectionKey<T> = symbol & InjectionConstraint<T>

/**
 * 提供依赖注入的值
 * @param key - 注入的key,可以是InjectionKey、字符串或数字
 * @param value - 注入的值
 */
export function provide<T, K = InjectionKey<T> | string | number>(
  key: K,
  value: K extends InjectionKey<infer V> ? V : T,
): void {
  // 检查是否在setup()中调用
  if (!currentInstance) {
    if (__DEV__) {
      warn(`provide() can only be used inside setup().`)
    }
  } else {
    // 获取当前组件实例上的 provides 对象
    let provides = currentInstance.provides
    // 默认情况下,实例继承其父级的provides对象
    // 但当它需要提供自己的值时,会创建自己的provides对象,
    // 使用父级provides对象作为原型
    // 这样在`inject`中我们可以直接从直接父级查找注入,
    // 让原型链完成剩下的工作

    // 获取父组件实例上的 provides 对象
    const parentProvides =
      currentInstance.parent && currentInstance.parent.provides
    if (parentProvides === provides) {
      // 如果当前provides和父级的相同,说明还没有自己的provides对象
      // 创建一个以父级provides为原型的对象
      provides = currentInstance.provides = Object.create(parentProvides)
    }
    // TS不允许symbol作为索引类型,所以这里需要类型转换
    provides[key as string] = value
  }
}

export function inject<T>(key: InjectionKey<T> | string): T | undefined
export function inject<T>(
  key: InjectionKey<T> | string,
  defaultValue: T,
  treatDefaultAsFactory?: false,
): T
export function inject<T>(
  key: InjectionKey<T> | string,
  defaultValue: T | (() => T),
  treatDefaultAsFactory: true,
): T
/**
 * 注入依赖
 * @param key - 注入的key,可以是InjectionKey、字符串
 * @param defaultValue - 默认值,当找不到注入值时使用
 * @param treatDefaultAsFactory - 是否将默认值作为工厂函数处理
 */
export function inject(
  key: InjectionKey<any> | string,
  defaultValue?: unknown,
  treatDefaultAsFactory = false,
) {
  // 获取当前组件实例,如果在函数式组件中调用,则回退到currentRenderingInstance
  const instance = currentInstance || currentRenderingInstance

  // 支持通过app.runWithContext()从应用级provides中查找
  if (instance || currentApp) {
    // 确定provides来源:
    // 1. 如果在app.runWithContext()中,使用currentApp的provides
    // 2. 如果有组件实例:
    //    - 如果是根组件,使用appContext的provides
    //    - 否则使用父组件的provides
    // 3. 都不满足则为undefined
    const provides = currentApp
      ? currentApp._context.provides
      : instance
        ? instance.parent == null
          ? instance.vnode.appContext && instance.vnode.appContext.provides
          : instance.parent.provides
        : undefined

    // 如果在provides中找到对应的key,直接返回值，如果父组件没有，这里会按照原型链查找
    if (provides && (key as string | symbol) in provides) {
      return provides[key as string]
    }
    // 如果提供了默认值
    else if (arguments.length > 1) {
      // 如果defaultValue是函数且treatDefaultAsFactory为true,
      // 则调用函数获取默认值,否则直接返回defaultValue
      return treatDefaultAsFactory && isFunction(defaultValue)
        ? defaultValue.call(instance && instance.proxy)
        : defaultValue
    }
    // 开发环境下,找不到注入值时发出警告
    else if (__DEV__) {
      warn(`injection "${String(key)}" not found.`)
    }
  }
  // 开发环境下,如果不在setup或函数式组件中调用时发出警告
  else if (__DEV__) {
    warn(`inject() can only be used inside setup() or functional components.`)
  }
}

/**
 * Returns true if `inject()` can be used without warning about being called in the wrong place (e.g. outside of
 * setup()). This is used by libraries that want to use `inject()` internally without triggering a warning to the end
 * user. One example is `useRoute()` in `vue-router`.
 */
export function hasInjectionContext(): boolean {
  return !!(currentInstance || currentRenderingInstance || currentApp)
}
