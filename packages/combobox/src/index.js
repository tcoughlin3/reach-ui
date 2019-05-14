/* eslint-disable jsx-a11y/role-has-required-aria-props */
/* eslint-disable jsx-a11y/aria-proptypes */
/* eslint-disable jsx-a11y/role-supports-aria-props */
/* eslint-disable default-case */

////////////////////////////////////////////////////////////////////////////////
// Welcome to @reach/combobox! State transitions are managed by a state chart,
// state mutations are managed by a reducer. Please enjoy the read here, I
// figured out a few new tricks with context and refs I think you might love or
// hate 😂

import React, {
  forwardRef,
  createContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useContext,
  useMemo,
  useReducer,
  useState
} from "react";
import { func } from "prop-types";
import { wrapEvent, assignRef } from "@reach/utils";
import { findAll } from "highlight-words-core";
import escapeRegexp from "escape-regexp";
import { useId } from "@reach/auto-id";
import Popover, { positionMatchWidth } from "@reach/popover";

////////////////////////////////////////////////////////////////////////////////
// States

// Nothing going on, waiting for the user to type or use the arrow keys
const IDLE = "IDLE";

// The component is suggesting options as the user types
const SUGGESTING = "SUGGESTING";

// The user is using the keyboard to navigate the list, not typing
const NAVIGATING = "NAVIGATING";

// The user is interacting with arbitrary elements inside the popup that
// are not ComboboxInputs
const INTERACTING = "INTERACTING";

////////////////////////////////////////////////////////////////////////////////
// Actions:

// User cleared the value w/ backspace, but input still has focus
const CLEAR = "CLEAR";

// User is typing
const CHANGE = "CHANGE";

// User is navigating w/ the keyboard
const NAVIGATE = "NAVIGATE";

// User can be navigating with keyboard and then
// click instead, we want the value from the click,
// not the current nav item
const SELECT_WITH_KEYBOARD = "SELECT_WITH_KEYBOARD";
const SELECT_WITH_CLICK = "SELECT_WITH_CLICK";

// Pretty self-explanatory, user can hit escape or
// blur to close the popover
const ESCAPE = "ESCAPE";
const BLUR = "BLUR";

// The user left the input to interact with arbitrary elements inside the
// popup
const INTERACT = "INTERACT";

////////////////////////////////////////////////////////////////////////////////
const stateChart = {
  initial: IDLE,
  states: {
    [IDLE]: {
      on: {
        [BLUR]: IDLE,
        [CLEAR]: IDLE,
        [CHANGE]: SUGGESTING,
        [NAVIGATE]: NAVIGATING
      }
    },
    [SUGGESTING]: {
      on: {
        [CHANGE]: SUGGESTING,
        [NAVIGATE]: NAVIGATING,
        [CLEAR]: IDLE,
        [ESCAPE]: IDLE,
        [BLUR]: IDLE,
        [SELECT_WITH_CLICK]: IDLE,
        [INTERACT]: INTERACTING
      }
    },
    [NAVIGATING]: {
      on: {
        [CHANGE]: SUGGESTING,
        [CLEAR]: IDLE,
        [BLUR]: IDLE,
        [ESCAPE]: IDLE,
        [NAVIGATE]: NAVIGATING,
        [SELECT_WITH_KEYBOARD]: IDLE,
        [SELECT_WITH_CLICK]: IDLE,
        [INTERACT]: INTERACTING
      }
    },
    [INTERACTING]: {
      on: {
        [CHANGE]: SUGGESTING,
        [BLUR]: IDLE,
        [ESCAPE]: IDLE,
        [NAVIGATE]: NAVIGATING
      }
    }
  }
};

function reducer(data, action) {
  const nextState = { ...data, lastActionType: action.type };
  switch (action.type) {
    case CHANGE:
      return {
        ...nextState,
        navigationValue: null,
        value: action.value
      };
    case NAVIGATE:
      return {
        ...nextState,
        navigationValue: action.value
      };
    case CLEAR:
      return {
        ...nextState,
        value: "",
        navigationValue: null
      };
    case BLUR:
    case ESCAPE:
      return {
        ...nextState,
        navigationValue: null
      };
    case SELECT_WITH_CLICK:
      return {
        ...nextState,
        value: action.value,
        navigationValue: null
      };
    case SELECT_WITH_KEYBOARD:
      return {
        ...nextState,
        value: data.navigationValue,
        navigationValue: null
      };
    case INTERACT:
      return { ...nextState, navigationValue: null };

    default:
      throw new Error(`Unknown action ${action.type}`);
  }
}

const visibleStates = [SUGGESTING, NAVIGATING, INTERACTING];
const isVisible = state => visibleStates.includes(state);

////////////////////////////////////////////////////////////////////////////////
// Combobox

const Context = createContext();
export const Combobox = forwardRef(function Combobox(
  { children, as: Comp = "div", onSelect, ...rest },
  ref
) {
  // We store the values of all the ComboboxOptions on this ref. This makes it
  // possible to perform the keyboard navigation from the input on the list. We
  // manipulate this array through context so that we don't have to enforce a
  // parent/child relationship between ComboboxList and ComboboxOption with
  // cloneElement or fall back to DOM traversal. It's a new trick for me and
  // I'm pretty excited about it.
  const optionsRef = useRef(null);

  // Need this to focus it
  const inputRef = useRef();

  const popupRef = useRef();

  // When <ComboboxInput autocomplete={false} /> we don't want cycle back to
  // the user's value while navigating (because it's always the user's value),
  // but we need to know this in useKeyDown which is far away from the prop
  // here, so we do something sneaky and write it to this ref on context so we
  // can use it anywhere else 😛. Another new trick for me and I'm excited
  // about this one too!
  const autocompletePropRef = useRef();

  const defaultData = {
    // the value the user has typed, we derived this also when the developer is
    // controlling the value of ComboboxInput
    value: "",
    // the value the user has navigated to with the keyboard
    navigationValue: null
  };

  const [state, data, transition] = useReducerMachine(
    stateChart,
    reducer,
    defaultData
  );

  useFocusManagement(data.lastActionType, inputRef, data.navigationValue);

  const listboxId = `listbox:${useId()}`;

  const context = useMemo(() => {
    return {
      data,
      inputRef,
      popupRef,
      onSelect,
      optionsRef,
      state,
      transition,
      listboxId,
      autocompletePropRef
    };
  }, [data, onSelect, state, transition, listboxId]);

  return (
    <Context.Provider value={context}>
      <Comp
        {...rest}
        data-reach-combobox
        ref={ref}
        role="combobox"
        aria-haspopup="listbox"
        aria-owns={listboxId}
        aria-expanded={isVisible(state)}
      >
        {children}
      </Comp>
    </Context.Provider>
  );
});

Combobox.propTypes = { onSelect: func };

////////////////////////////////////////////////////////////////////////////////
// ComboboxInput

export const ComboboxInput = forwardRef(function ComboboxInput(
  {
    as: Comp = "input",

    // highlights all the text in the box on click when true
    selectOnClick = false,
    autocomplete = true,

    // wrapped events
    onClick,
    onChange,
    onKeyDown,
    onBlur,
    onFocus,

    // might be controlled
    value: controlledValue,
    ...props
  },
  forwardedRef
) {
  const {
    data: { navigationValue, value },
    inputRef,
    state,
    transition,
    listboxId,
    autocompletePropRef
  } = useContext(Context);

  // Because we close the List on blur, we need to track if the blur is
  // caused by clicking inside the list, and if so, don't close the List.
  const selectOnClickRef = useRef(false);

  const handleKeyDown = useKeyDown();

  const handleBlur = useBlur();

  const isControlled = controlledValue != null;

  useLayoutEffect(() => {
    autocompletePropRef.current = autocomplete;
  });

  const handleValueChange = value => {
    if (value.trim() === "") {
      transition(CLEAR);
    } else {
      transition(CHANGE, { value });
    }
  };

  // If they are controlling the value we still need to do our transitions so
  // we have this derived state to emulate onChange of the input as we receive
  // new `value`s ...
  if (isControlled && controlledValue !== value) {
    handleValueChange(controlledValue);
  }

  // ... and we don't trigger handleValueChange as the user types, we just let
  // the developer control it with the normal input onChange prop
  const handleChange = event => {
    if (!isControlled) {
      handleValueChange(event.target.value);
    }
  };

  const handleFocus = () => {
    if (selectOnClick) {
      selectOnClickRef.current = true;
    }
  };

  const handleClick = () => {
    if (selectOnClickRef.current) {
      selectOnClickRef.current = false;
      inputRef.current.select();
    }
  };

  const inputValue =
    autocomplete && state === NAVIGATING
      ? // When idle, we don't have a navigationValue on ArrowUp/Down
        navigationValue || controlledValue || value
      : controlledValue || value;

  return (
    <Comp
      {...props}
      data-reach-combobox-input
      ref={node => {
        assignRef(inputRef, node);
        assignRef(forwardedRef, node);
      }}
      value={inputValue}
      onClick={wrapEvent(onClick, handleClick)}
      onBlur={wrapEvent(onBlur, handleBlur)}
      onFocus={wrapEvent(onFocus, handleFocus)}
      onChange={wrapEvent(onChange, handleChange)}
      onKeyDown={wrapEvent(onKeyDown, handleKeyDown)}
      id={listboxId}
      aria-autocomplete="both"
      aria-activedescendant={
        navigationValue ? makeHash(navigationValue) : undefined
      }
    />
  );
});

////////////////////////////////////////////////////////////////////////////////
// ComboboxPopup

export const ComboboxPopup = forwardRef(function ComboboxPopup(
  { onKeyDown, onBlur, ...props },
  forwardedRef
) {
  const { state, popupRef, inputRef } = useContext(Context);
  const handleKeyDown = useKeyDown();
  const handleBlur = useBlur();

  // Instead of conditionally rendering the popover we use the `hidden` prop
  // because we don't want to unmount on close (from escape or onSelect).  If
  // we unmounted, then we'd the optionsRef and the user wouldn't be able to
  // use the arrow keys to pop the list back open. However, the developer can
  // conditionally render the ComboboxPopup if they do want to cause
  // mount/unmount based on the app's own data (like results.length or
  // whatever).
  const hidden = !isVisible(state);

  return (
    <Popover
      {...props}
      data-reach-combobox-popup=""
      targetRef={inputRef}
      position={positionMatchWidth}
      ref={node => {
        assignRef(popupRef, node);
        assignRef(forwardedRef, node);
      }}
      onKeyDown={wrapEvent(onKeyDown, handleKeyDown)}
      onBlur={wrapEvent(onBlur, handleBlur)}
      hidden={hidden}
      // Allow the user to click inside the popover without causing it to blur
      // and close.
      tabIndex="-1"
    />
  );
});

////////////////////////////////////////////////////////////////////////////////
// ComboboxList

export const ComboboxList = forwardRef(function ComboboxList(
  { as: Comp = "ul", style, ...props },
  ref
) {
  const { optionsRef } = useContext(Context);

  // WEIRD? Reset the options ref every render so that they are always
  // accurate and ready for keyboard navigation handlers. Using layout
  // effect to schedule this effect before the ComboboxOptions push into
  // the array
  useLayoutEffect(() => {
    optionsRef.current = [];
    return () => (optionsRef.current = []);
  });

  return (
    <Comp {...props} ref={ref} data-reach-combobox-list="" role="listbox" />
  );
});

////////////////////////////////////////////////////////////////////////////////
// ComboboxOption

// Allows us to put the option's value on context so that ComboboxOptionText
// can work it's highlight text magic no matter what else is rendered around
// it.
const OptionContext = createContext();

export const ComboboxOption = forwardRef(function ComboboxOption(
  { children, value, onClick, onMouseDown, ...props },
  ref
) {
  const {
    onSelect,
    data: { navigationValue },
    transition,
    optionsRef
  } = useContext(Context);

  useEffect(() => {
    optionsRef.current.push(value);
  });

  const isActive = navigationValue === value;

  const handleClick = () => {
    onSelect && onSelect(value);
    transition(SELECT_WITH_CLICK, { value });
  };

  return (
    <OptionContext.Provider value={value}>
      <li
        {...props}
        data-reach-combobox-option
        ref={ref}
        id={makeHash(value)}
        role="option"
        aria-selected={isActive}
        // without this the menu will close from `onBlur`, but with it the
        // element can be `document.activeElement` and then our focus checks in
        // onBlur will work as intended
        tabIndex="-1"
        onClick={wrapEvent(onClick, handleClick)}
        children={children || <ComboboxOptionText />}
      />
    </OptionContext.Provider>
  );
});

////////////////////////////////////////////////////////////////////////////////
// ComboboxOptionText

// We don't forwardRef or spread props because we render multiple spans or null,
// should be fine 🤙
export function ComboboxOptionText() {
  const value = useContext(OptionContext);
  const {
    data: { value: contextValue }
  } = useContext(Context);

  const searchWords = escapeRegexp(contextValue).split(/\s+/);
  const textToHighlight = value;
  const results = useMemo(() => findAll({ searchWords, textToHighlight }), [
    searchWords,
    textToHighlight
  ]);

  return results.length
    ? results.map((result, index) => {
        const str = value.slice(result.start, result.end);
        return (
          <span
            key={index}
            data-user-value={result.highlight ? true : undefined}
            data-suggested-value={result.highlight ? undefined : true}
          >
            {str}
          </span>
        );
      })
    : value;
}

////////////////////////////////////////////////////////////////////////////////
// The rest is all implementation details

// Move focus back to the input if we start navigating w/ the
// keyboard after focus has moved to any focusable content in
// the popup.
function useFocusManagement(lastActionType, inputRef, navigationValue) {
  useEffect(() => {
    if (lastActionType === NAVIGATE || lastActionType === ESCAPE) {
      inputRef.current.focus();
    }
  });
}

// We want the same events when the input or the popup have focus (HOW COOL ARE
// HOOKS BTW?) This is probably the hairiest piece but it's not bad.
function useKeyDown() {
  const {
    data: { navigationValue },
    onSelect,
    optionsRef,
    state,
    transition,
    autocompletePropRef
  } = useContext(Context);

  return function handleKeyDown(event) {
    const { current: options } = optionsRef;
    switch (event.key) {
      case "ArrowDown": {
        // Don't scroll the page
        event.preventDefault();

        // If the developer didn't render any options, there's no point in
        // trying to navigate--but seriously what the heck? Give us some
        // options fam.
        if (!options || options.length === 0) {
          return;
        }

        if (state === IDLE) {
          // Opening a closed list, we don't want to select anything,
          // just open it and reveal the many options before us
          transition(NAVIGATE, { value: null });
        } else {
          const index = options.indexOf(navigationValue);
          const atBottom = index === options.length - 1;
          if (atBottom) {
            if (autocompletePropRef.current) {
              // Go back to the value the user has typed because we are
              // autocompleting and they need to be able to get back to what
              // they had typed w/o having to backspace out.
              transition(NAVIGATE, { value: null });
            } else {
              // cycle through
              const firstOption = options[0];
              transition(NAVIGATE, { value: firstOption });
            }
          } else {
            // Go to the next item in the list
            const nextValue = options[(index + 1) % options.length];
            transition(NAVIGATE, { value: nextValue });
          }
        }
        break;
      }
      // A lot of duplicate code with ArrowDown up next, I'm already over it.
      case "ArrowUp": {
        // Don't scroll the page
        event.preventDefault();

        // If the developer didn't render any options, there's no point in
        // trying to navigate--but seriously what the heck? Give us some
        // options fam.
        if (!options || options.length === 0) {
          return;
        }

        if (state === IDLE) {
          transition(NAVIGATE, { value: null });
        } else {
          const index = options.indexOf(navigationValue);
          if (index === 0) {
            if (autocompletePropRef.current) {
              // Go back to the value the user has typed because we are
              // autocompleting and they need to be able to get back to what
              // they had typed w/o having to backspace out.
              transition(NAVIGATE, { value: null });
            } else {
              // cycle through
              const lastOption = options[options.length - 1];
              transition(NAVIGATE, { value: lastOption });
            }
          } else if (index === -1) {
            // displaying the user's value, so go select the last one
            const value = options.length ? options[options.length - 1] : null;
            transition(NAVIGATE, { value });
          } else {
            // normal case, select previous
            const nextValue =
              options[(index - 1 + options.length) % options.length];
            transition(NAVIGATE, { value: nextValue });
          }
        }
        break;
      }
      case "Escape": {
        if (state !== IDLE) {
          transition(ESCAPE);
        }
        break;
      }
      case "Enter": {
        if (state === NAVIGATING && navigationValue !== null) {
          // don't want to submit forms
          event.preventDefault();
          onSelect && onSelect(navigationValue);
          transition(SELECT_WITH_KEYBOARD);
        }
        break;
      }
    }
  };
}

function useBlur() {
  const { state, transition, popupRef, inputRef } = useContext(Context);

  return function handleBlur(event) {
    requestAnimationFrame(() => {
      // we on want to close only if focus rests outside the menu
      if (document.activeElement !== inputRef.current && popupRef.current) {
        if (popupRef.current.contains(document.activeElement)) {
          // focus landed inside the popup, keep it open, but we don't want
          // "Enter" causing the popover to close, so we clear the navigation
          // value to act like there's no navigation going on anymore (cause
          // there isn't!)
          if (state !== INTERACTING) {
            transition(INTERACT);
          }
        } else {
          // focus landed outside the popup, close it.
          transition(BLUR);
        }
      }
    });
  };
}

// This is a cool state machine, as usual, it manages transitions between
// states, but this one has a built in reducer to manage the data that goes
// with those transitions.
function useReducerMachine(chart, reducer, initialData) {
  const [state, setState] = useState(chart.initial);
  const [data, dispatch] = useReducer(reducer, initialData);

  const transition = (action, payload = {}) => {
    const currentState = chart.states[state];
    const nextState = currentState.on[action];
    if (!nextState) {
      throw new Error(`Unknown action "${action}" for state "${state}"`);
    }
    dispatch({ type: action, state, nextState: state, ...payload });
    setState(nextState);
  };

  return [state, data, transition];
}

// We don't want to track the active descendant with indexes because nothing is
// more annoying in a combobox than having it change values RIGHT AS YOU HIT
// ENTER. That only happens if you use the index as your data, rather than
// *your data as your data*. We use this to generate a unique ID based on the
// value of each item.  This function is short, sweet, and good enough™ (I also
// don't know how it works, tbqh)
// https://stackoverflow.com/questions/6122571/simple-non-secure-hash-function-for-javascript
const makeHash = str => {
  let hash = 0;
  if (str.length === 0) {
    return hash;
  }
  for (let i = 0; i < str.length; i++) {
    var char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash;
};

////////////////////////////////////////////////////////////////////////////////
// Well alright, you made it all the way here to like 700 lines of code (geez,
// what the heck?). Have a great day :D
