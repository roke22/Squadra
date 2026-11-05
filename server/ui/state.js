import { store } from './dom.js'

// What several parts of the dashboard change. (The rest of what it knows lives with the part that uses it.)
export const state = {
  token: store.get('squadraToken') ?? store.get('swarmToken'),
  // 'auto' (fit the screen) or a fixed number of columns
  cols: store.get('squadraCols') || store.get('swarmCols') || 'auto',
  // The mosaic shows each session's live terminal (when it has one) or its chat.
  mosaicMode: store.get('squadraMosaicMode') === 'chats' ? 'chats' : 'terms',
  mosaicKey: null, // what the panes on screen were built for
  groups: [], // [{id, members}]
  templates: [], // squad templates [{name, host, coordinator, workers}]
  links: [], // linked coordinators of two squads [{a, b}]
  serverSkew: 0,
  streamAbort: null,
  streamHelloSeen: false,
  sessionView: null,
  menuEl: null,
  squadMeta: new Map(), // coordinator -> {title, goal, x, y}
  termView: null,
  // Each sign-in has its own stream loop: an older one (waiting to reconnect
  // when the admin logged out) stops instead of opening a second stream.
  streamGen: 0,
}

export const sessions = new Map()      // name -> session view (from server)
export const hosts = new Map()         // host id -> host view (machines running squadra-host)
export const templateListeners = new Set()
export const linkListeners = new Set()
export const linksOf = name => state.links.filter(l => l.a === name || l.b === name).map(l => (l.a === name ? l.b : l.a))
export const unread = new Map()         // name -> count (while not visible)
export const views = new Set()          // live ChatViews

export const hostListeners = new Set()
