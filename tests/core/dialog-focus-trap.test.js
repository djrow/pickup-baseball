/**
 * Unit & Integration tests for PBFDialog.trapFocus (WCAG 2.1 AA focus trap, sibling inert, Escape, and restoration)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dialogSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'dialog.js'), 'utf8');

function createDOMFixture() {
  let activeElement = null;

  class FakeNode {
    constructor(tagName) {
      this.tagName = tagName ? tagName.toUpperCase() : 'DIV';
      this.nodeType = 1;
      this.children = [];
      this.parentElement = null;
      this.parentNode = null;
      this.attributes = {};
      this.classList = new Set();
      this.style = {};
      this.tabIndex = 0;
      this.inert = false;
      this.disabled = false;
      this.offsetWidth = 100;
      this.offsetHeight = 30;
      this._eventListeners = {};
    }

    getAttribute(name) {
      return this.attributes[name] || null;
    }

    setAttribute(name, val) {
      this.attributes[name] = String(val);
      if (name === 'tabindex') this.tabIndex = parseInt(val, 10);
      if (name === 'disabled') this.disabled = true;
    }

    removeAttribute(name) {
      delete this.attributes[name];
      if (name === 'disabled') this.disabled = false;
    }

    appendChild(child) {
      child.parentElement = this;
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentElement = null;
        child.parentNode = null;
      }
      return child;
    }

    getClientRects() {
      return [{ width: this.offsetWidth, height: this.offsetHeight }];
    }

    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    focus() {
      activeElement = this;
    }

    addEventListener(event, handler) {
      if (!this._eventListeners[event]) this._eventListeners[event] = [];
      this._eventListeners[event].push(handler);
    }

    removeEventListener(event, handler) {
      if (!this._eventListeners[event]) return;
      this._eventListeners[event] = this._eventListeners[event].filter((h) => h !== handler);
    }

    dispatchEvent(evt) {
      const list = this._eventListeners[evt.type] || [];
      for (const h of list) h(evt);
    }

    querySelectorAll(sel) {
      const results = [];
      function walk(node) {
        for (const c of node.children) {
          if (sel.includes('button') && c.tagName === 'BUTTON' && !c.disabled) {
            results.push(c);
          } else if (sel.includes('input') && c.tagName === 'INPUT' && !c.disabled) {
            results.push(c);
          } else if (sel.includes('[tabindex]') && c.tabIndex >= 0) {
            results.push(c);
          }
          walk(c);
        }
      }
      walk(this);
      return results;
    }

    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
  }

  const body = new FakeNode('BODY');
  const main = new FakeNode('MAIN');
  const aside = new FakeNode('ASIDE');
  const footer = new FakeNode('FOOTER');
  body.appendChild(main);
  body.appendChild(aside);
  body.appendChild(footer);

  const buttonOutside = new FakeNode('BUTTON');
  main.appendChild(buttonOutside);

  const modalContainer = new FakeNode('DIV');
  modalContainer.setAttribute('role', 'dialog');
  const btn1 = new FakeNode('BUTTON');
  const btn2 = new FakeNode('BUTTON');
  modalContainer.appendChild(btn1);
  modalContainer.appendChild(btn2);
  body.appendChild(modalContainer);

  const documentListeners = {};
  const fakeDoc = {
    body: body,
    activeElement: buttonOutside,
    createElement: (tag) => new FakeNode(tag),
    addEventListener: (evt, fn) => {
      if (!documentListeners[evt]) documentListeners[evt] = [];
      documentListeners[evt].push(fn);
    },
    removeEventListener: (evt, fn) => {
      if (!documentListeners[evt]) return;
      documentListeners[evt] = documentListeners[evt].filter((f) => f !== fn);
    },
    dispatchEvent: (evt) => {
      const list = documentListeners[evt.type] || [];
      for (const fn of list) fn(evt);
    }
  };

  const fakeWin = {
    document: fakeDoc,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    API: { t: (k, fb) => fb }
  };

  return {
    window: fakeWin,
    document: fakeDoc,
    body,
    main,
    aside,
    footer,
    buttonOutside,
    modalContainer,
    btn1,
    btn2,
    getActiveElement: () => activeElement,
    setActiveElement: (el) => { activeElement = el; }
  };
}

function registerDialogFocusTrapTests() {
test('PBFDialog.trapFocus: manages inert on siblings, cycles Tab, and handles Escape', async (_t) => {
  const fx = createDOMFixture();
  const sandbox = {
    window: fx.window,
    document: fx.document,
    setTimeout: (fn) => fn(),
    module: { exports: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(dialogSrc, sandbox);
  const PBFDialog = sandbox.window.PBFDialog;

  assert.equal(typeof PBFDialog.trapFocus, 'function', 'PBFDialog exports trapFocus');

  fx.setActiveElement(fx.buttonOutside);

  let escapeTriggered = false;
  const trap = PBFDialog.trapFocus(fx.modalContainer, {
    triggerEl: fx.buttonOutside,
    escape: true,
    onEscape: () => {
      escapeTriggered = true;
    },
    siblingInert: true,
    initialFocus: fx.btn1
  });

  // 1. Siblings of modalContainer under body should have inert = true
  assert.equal(fx.main.inert, true, 'main sibling is inert');
  assert.equal(fx.aside.inert, true, 'aside sibling is inert');
  assert.equal(fx.footer.inert, true, 'footer sibling is inert');
  assert.equal(fx.modalContainer.inert, false, 'modal container itself is not inert');

  // 2. Escape triggers onEscape callback
  let defaultPrevented = false;
  let propagationStopped = false;
  fx.document.dispatchEvent({
    type: 'keydown',
    key: 'Escape',
    preventDefault: () => { defaultPrevented = true; },
    stopPropagation: () => { propagationStopped = true; }
  });
  assert.equal(escapeTriggered, true, 'Escape key triggers onEscape');
  assert.equal(defaultPrevented, true, 'Escape default prevented');
  assert.equal(propagationStopped, true, 'Escape propagation stopped');

  // 3. Tab cycling
  fx.setActiveElement(fx.btn2);
  let tabPrevented = false;
  fx.document.dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    shiftKey: false,
    preventDefault: () => { tabPrevented = true; }
  });
  assert.equal(tabPrevented, true, 'Forward Tab wraps to first focusable element');
  assert.equal(fx.getActiveElement(), fx.btn1, 'Focus cycled from btn2 to btn1');

  // Shift+Tab cycling
  fx.setActiveElement(fx.btn1);
  let shiftTabPrevented = false;
  fx.document.dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    shiftKey: true,
    preventDefault: () => { shiftTabPrevented = true; }
  });
  assert.equal(shiftTabPrevented, true, 'Backward Shift+Tab wraps to last element');
  assert.equal(fx.getActiveElement(), fx.btn2, 'Focus cycled from btn1 to btn2');

  // 4. Release cleans up inert and restores focus to triggerEl
  trap.release();
  assert.equal(fx.main.inert, false, 'main is no longer inert');
  assert.equal(fx.aside.inert, false, 'aside is no longer inert');
  assert.equal(fx.footer.inert, false, 'footer is no longer inert');
  assert.equal(fx.getActiveElement(), fx.buttonOutside, 'Focus restored to buttonOutside');
});

test('PBFDialog.trapFocus: coordinates stacked drawer + modal traps without inert deadlock', async (_t) => {
  const fx = createDOMFixture();
  // Reset fixture children to mirror Clubhouse DOM:
  // body > [app > [sidebar, main, backdrop], modal]
  fx.body.children = [];
  const app = fx.document.createElement('DIV');
  const sidebar = fx.document.createElement('ASIDE');
  const sidebarTriggerBtn = fx.document.createElement('BUTTON');
  sidebar.appendChild(sidebarTriggerBtn);
  const main = fx.document.createElement('MAIN');
  const mainBtn = fx.document.createElement('BUTTON');
  main.appendChild(mainBtn);
  const backdrop = fx.document.createElement('DIV');
  app.appendChild(sidebar);
  app.appendChild(main);
  app.appendChild(backdrop);

  const modal = fx.document.createElement('DIV');
  modal.setAttribute('role', 'dialog');
  const modalDoneBtn = fx.document.createElement('BUTTON');
  modal.appendChild(modalDoneBtn);

  fx.body.appendChild(app);
  fx.body.appendChild(modal);

  const sandbox = {
    window: fx.window,
    document: fx.document,
    setTimeout: (fn) => fn(),
    module: { exports: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(dialogSrc, sandbox);
  const PBFDialog = sandbox.window.PBFDialog;

  fx.setActiveElement(mainBtn);
  let sidebarEscapes = 0;
  let modalEscapes = 0;

  // 1. Open mobile drawer trap with backdrop excluded from inert
  const drawerTrap = PBFDialog.trapFocus(sidebar, {
    triggerEl: mainBtn,
    escape: true,
    onEscape: () => { sidebarEscapes++; },
    siblingInert: true,
    excludeInert: [backdrop],
    initialFocus: sidebarTriggerBtn
  });
  assert.equal(backdrop.inert, false, 'backdrop excluded from inert while drawer trap is active');
  assert.equal(main.inert, true, 'main sibling marked inert while drawer trap is active');
  assert.equal(modal.inert, true, 'sibling modal marked inert while drawer trap is active');

  // 2. Open nested modal trap triggered from inside sidebar
  const modalTrap = PBFDialog.trapFocus(modal, {
    triggerEl: sidebarTriggerBtn,
    escape: true,
    onEscape: () => { modalEscapes++; },
    siblingInert: true,
    initialFocus: modalDoneBtn
  });
  assert.equal(modal.inert, false, 'nested modal must not remain inert under drawer trap');
  assert.equal(app.inert, true, 'background app becomes inert under topmost modal trap');

  // 3. Escape targets only topmost modal trap
  fx.document.dispatchEvent({
    type: 'keydown',
    key: 'Escape',
    preventDefault: () => {},
    stopPropagation: () => {}
  });
  assert.equal(modalEscapes, 1, 'Escape triggers topmost modal onEscape');
  assert.equal(sidebarEscapes, 0, 'Escape does not trigger underlying drawer onEscape');

  // 4. Release modal trap restores drawer sibling-inert & focus to sidebar trigger
  modalTrap.release();
  assert.equal(app.inert, false, 'app is no longer inert after modal closes');
  assert.equal(sidebar.inert, false, 'sidebar remains interactive while drawer trap stays active');
  assert.equal(main.inert, true, 'main inertness restored from underlying drawer trap');
  assert.equal(modal.inert, true, 'modal returned to inert while underlying drawer trap active');
  assert.equal(backdrop.inert, false, 'backdrop stays excluded from inert after modal closes');
  assert.equal(fx.getActiveElement(), sidebarTriggerBtn, 'focus restored to drawer trigger button');

  // 5. Out-of-order release (drawer closes while modal is still open, e.g. resize)
  const modalTrap2 = PBFDialog.trapFocus(modal, {
    triggerEl: sidebarTriggerBtn,
    escape: true,
    onEscape: () => { modalEscapes++; },
    siblingInert: true,
    initialFocus: modalDoneBtn
  });
  assert.equal(fx.getActiveElement(), modalDoneBtn, 'modalDoneBtn focused');
  drawerTrap.release();
  assert.equal(modal.inert, false, 'out-of-order drawer release leaves active modal interactive');
  assert.equal(app.inert, true, 'out-of-order drawer release keeps background app inert');
  assert.equal(fx.getActiveElement(), modalDoneBtn, 'out-of-order drawer release does not steal focus from modal');

  // 6. Release remaining modal trap -> clean DOM
  modalTrap2.release();
  assert.equal(app.inert, false, 'app inertness cleared when all traps released');
  assert.equal(sidebar.inert, false, 'sidebar inertness cleared when all traps released');
  assert.equal(main.inert, false, 'main inertness cleared when all traps released');
  assert.equal(backdrop.inert, false, 'backdrop inertness cleared when all traps released');
  assert.equal(modal.inert, false, 'modal inertness cleared when all traps released');
});
}

if (require.main === module) {
  registerDialogFocusTrapTests();
}
module.exports = registerDialogFocusTrapTests;
