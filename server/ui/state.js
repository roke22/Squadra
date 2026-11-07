import { store } from './dom.js'

// What several parts of the dashboard change. (The rest of what it knows lives with the part that uses it.)
export const state = {
  me: null, // who signed in, once it is finished (see /api/me)
  // The company shown: from the address, or the last one in this browser. Changing
  // it loads the page again, so nothing of another stays in memory.
  company: new URLSearchParams(location.search).get('company') ?? store.get('squadraCompany'),
  role: null, // what this user is in it
  // 'auto' (fit the screen) or a fixed number of columns
  cols: store.get('squadraCols') || store.get('swarmCols') || 'auto',
  // The mosaic shows each session's live terminal (when it has one) or its chat.
  mosaicMode: store.get('squadraMosaicMode') === 'chats' ? 'chats' : 'terms',
  mosaicKey: null, // what the panes on screen were built for
  groups: [], // [{id, members}]
  templates: [], // squad templates [{name, host, coordinator, workers}]
  links: [], // linked coordinators of two squads [{a, b}]
  inbox: [], // what coordinators left for the user
  serverSkew: 0,
  streamAbort: null,
  streamHelloSeen: false,
  sessionView: null,
  menuEl: null,
  squadMeta: new Map(), // coordinator -> {title, goal, x, y}
  termView: null,
  // Each sign-in has its own stream loop: an older one (waiting to reconnect
  // when the user logged out) stops instead of opening a second stream.
  streamGen: 0,
}

// What is remembered per company has it in its name. (Not the first company:
// its preferences are there from before there were companies.)
export const companyPref = key => (state.company && state.company !== 'default' ? `${key}:${state.company}` : key)

// Whether this user's role in this company allows that, at least: what they
// can't do isn't offered. (The server is who decides. See the skill frontend-design.)
const ROLES = ['observer', 'operator', 'manager', 'owner']
export const can = needed => ROLES.indexOf(state.role) >= ROLES.indexOf(needed)

export const sessions = new Map()      // name -> session view (from server)
export const hosts = new Map()         // host id -> host view (machines running squadra-host)
export const templateListeners = new Set()
export const linkListeners = new Set()
export const linksOf = name => state.links.filter(l => l.a === name || l.b === name).map(l => (l.a === name ? l.b : l.a))
export const unread = new Map()         // name -> count (while not visible)
export const views = new Set()          // live ChatViews

export const hostListeners = new Set()
