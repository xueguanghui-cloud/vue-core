import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { arrayInstrumentations } from './arrayInstrumentations'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import { ITERATE_KEY, track, trigger } from './dep'
import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*@__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*@__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => Symbol[key as keyof SymbolConstructor])
    .filter(isSymbol),
)

function hasOwnProperty(this: object, key: unknown) {
  // #10455 hasOwnProperty may be called with non-string values
  if (!isSymbol(key)) key = String(key)
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key as string)
}

/**
 * 基础响应式处理器类，实现了 ProxyHandler 接口
 * 用于处理响应式对象的基本操作
 */
class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    // 是否只读
    protected readonly _isReadonly = false,
    // 是否浅响应
    protected readonly _isShallow = false,
  ) {}

  /**
   * 拦截对象属性的读取操作
   * @param target 目标对象
   * @param key 要读取的属性
   * @param receiver 代理对象或继承自代理对象的对象
   */
  get(target: Target, key: string | symbol, receiver: object): any {
    const isReadonly = this._isReadonly,
      isShallow = this._isShallow

    // 处理特殊的内部标记属性
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return isShallow
    } else if (key === ReactiveFlags.RAW) {
      // 如果接收者就是目标对象对应的代理对象，或者接收者是代理对象的用户代理
      if (
        receiver ===
          (isReadonly
            ? isShallow
              ? shallowReadonlyMap
              : readonlyMap
            : isShallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        // receiver 不是响应式代理，但有相同的原型
        // 这意味着 receiver 是响应式代理的用户代理
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        return target
      }
      // 提前返回 undefined
      return
    }

    const targetIsArray = isArray(target)

    // 非只读对象的特殊处理
    if (!isReadonly) {
      let fn: Function | undefined
      // 如果是数组，使用数组的特殊操作方法
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn
      }
      // 处理 hasOwnProperty 方法
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    // 获取属性值
    const res = Reflect.get(
      target,
      key,
      // 如果目标是 ref，使用原始 ref 作为 receiver
      // 这样在调用其类方法时就不需要调用 toRaw
      isRef(target) ? target : receiver,
    )

    // 对于内置 Symbol 或不可跟踪的键，直接返回结果
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 非只读对象进行依赖追踪
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 浅响应模式直接返回结果
    if (isShallow) {
      return res
    }

    // 处理 ref 类型的值
    if (isRef(res)) {
      // ref 解包 - 对于数组的整数键跳过解包
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    // 处理对象类型的值
    if (isObject(res)) {
      // 如果 isReadonly 是 true，那么直接返回 readonly(res)
      // 如果 res 是个对象或者数组类型，则递归执行 reactive 函数把 res 变成响应式
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(false, isShallow)
  }

  set(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    let oldValue = target[key]
    // 不是浅层响应式，这里默认是false
    if (!this._isShallow) {
      const isOldValueReadonly = isReadonly(oldValue)
      // 不是浅层响应式对象
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          return false
        } else {
          oldValue.value = value
          return true
        }
      }
    } else {
      // 在浅模式中，对象被设置为原始值，而不管是否是响应式
    }

    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(
      target,
      key,
      value,
      isRef(target) ? target : receiver,
    )
    // 如果目标的原型链也是一个 proxy，通过 Reflect.set
    // 修改原型链上的属性会再次触发 setter，这种情况下就没必要触发两次 trigger 了
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  deleteProperty(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
  ): boolean {
    const hadKey = hasOwn(target, key)
    const oldValue = target[key]
    const result = Reflect.deleteProperty(target, key)
    if (result && hadKey) {
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }

  has(target: Record<string | symbol, unknown>, key: string | symbol): boolean {
    const result = Reflect.has(target, key)
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }

  ownKeys(target: Record<string | symbol, unknown>): (string | symbol)[] {
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY,
    )
    return Reflect.ownKeys(target)
  }
}

class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(true, isShallow)
  }

  set(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

export const mutableHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new MutableReactiveHandler()

export const readonlyHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new ReadonlyReactiveHandler()

export const shallowReactiveHandlers: MutableReactiveHandler =
  /*@__PURE__*/ new MutableReactiveHandler(true)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers: ReadonlyReactiveHandler =
  /*@__PURE__*/ new ReadonlyReactiveHandler(true)
