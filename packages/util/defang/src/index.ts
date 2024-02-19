/**
 * Extract from an object (usually a class prototype) the string union of the
 * names of its void methods
 */
type VoidMethods<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [P in keyof T]: T[P] extends (...args: any) => any
    ? ReturnType<T[P]> extends void
      ? P
      : never
    : never;
}[keyof T];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T> = new (...args: any[]) => T;

/**
 * Behold: Some of the more dangerous javascript you have ever seen.
 *
 * Defang any class, within reason, by rewriting a subset (of your choosing) of
 * its void methods such that they cannot throw errors. This is useful when you
 * _understand_ why a method throws errors but do not care about them. Maybe
 * you don't want to write try/catch blocks everywhere, maybe you don't control
 * the clients and they don't handle the errors as gracefully as you want to.
 *
 * The key thing to remember is that this is _very_ dangerous. Void functions
 * are obviously side-effecting. If the method fails, it's safe to assume there
 * was no effect. Sometimes, that's fine - maybe the effect is on an external
 * system with no consistency guarantees, so so if it doesn't happen your code,
 * locally, can keep chugging on. But maybe the effect is the second half of a
 * two-step mutation on the object itself and it's forever in a broken state
 * after the method fails, and the exception was to tell the client code to
 * throw the object away. If you've defanged the class, you won't know! Maybe
 * it's just a bad class that throws errors as flags, and now you're going to
 * miss those.
 *
 * To assuage my guilt at writing such a thing, I require your promise: use
 * this method judiciously.
 */
export function defang<T, C extends Constructor<T> = Constructor<T>>(
  Clazz: C,
  ...methods: VoidMethods<T>[]
): C {
  // Theoretically the passed constructor might _not_ be an extendable class of the right
  // kind, but in general we don't have to worry about that. `defang`'s callers must,
  // ironically, be prepared to be bitten.
  // @ts-expect-error we guarantee this is the right kind of class.
  const Defanged: C = class extends Clazz {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      super(...args);
    }
  };
  for (const meth of new Set(methods)) {
    const old = Defanged.prototype[meth];
    Object.defineProperty(Defanged.prototype, meth, {
      enumerable: false,
      writable: true,
      configurable: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value(this: T, ...args: any[]) {
        try {
          old.apply(this, args);
        } catch (e) {
          console.error(
            `defanged ${Clazz.name} tried to throw on ${String(meth)}:`
          );
          console.error(e);
        }
      },
    });
  }
  return Defanged;
}
