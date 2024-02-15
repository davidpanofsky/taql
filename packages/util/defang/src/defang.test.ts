import { defang } from './index';

class TestClass {
  n: string;
  c: number;
  constructor(name: string, counter: number) {
    this.n = name;
    this.c = counter;
  }

  getName() {
    return this.n;
  }
  getCount() {
    return this.c;
  }

  prefixName(p: string) {
    return p + this.n;
  }

  voidSucceed() {}
  voidFail() {
    throw new Error('fail on purpose!');
  }
  voidFail2() {
    throw new Error('fail on purpose!');
  }
}

describe('test defanging', () => {
  test('test base class', () => {
    const instance = new TestClass('testClass', 2);
    expect(instance.getCount()).toBe(2);
    expect(instance.getName()).toBe('testClass');
    instance.voidSucceed();
    try {
      instance.voidFail();
      fail('void fail should have failed');
    } catch {
      /*expected*/
    }
    // should be safe.
    try {
      instance.voidFail2();
      fail('void fail 2 should also have failed');
    } catch {
      /*expected*/
    }
  }),
    test('test defanging!', () => {
      defang<TestClass>(TestClass, 'voidFail');
      const Defanged = defang(TestClass, 'voidFail2');
      console.dir(TestClass);
      console.dir(Defanged);
      const defanged = new Defanged('a_test_name', 3);
      expect(defanged.getCount()).toBe(3);
      expect(defanged.getName()).toBe('a_test_name');
      defanged.voidSucceed();
      try {
        defanged.voidFail();
        fail('void fail should have failed');
      } catch {
        /*expected*/
      }
      // should be safe.
      defanged.voidFail2();
    });
});
