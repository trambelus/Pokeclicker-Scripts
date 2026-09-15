// ==UserScript==
// @name          Quest Assistant
// @namespace     https://github.com/trambelus/pokeclicker-quest-assistant/
// @author        Trambelus, Ephenia
// @license       GPL-3.0 License
// @version       1.0.0
// @description   Quest assistant for PokéClicker
// @match         https://www.pokeclicker.com/
// @icon          https://www.google.com/s2/favicons?domain=pokeclicker.com
// @grant         unsafeWindow
// @run-at        document-idle
// ==/UserScript==
function QuestAssistant () {
  /**
    * Adapted for use with https://github.com/ephymew/Pokeclicker-Scripts
    * Quest Assistant adds a multipurpose button to the right side of each in-progress quest's progress bar,
    * including quest lines' current step(s), for any recognized quest type below.
    * Provides quick access to quest-related actions.
    * - DefeatPokemonsQuest: Travel to region and route in quest, and enable enhancedautoclicker if available.
    * - GainGemsQuest: Sell enough gem plates to complete the quest, if enough are available.
    * - DefeatGymQuest: Travel to the gym specified in the quest.
    * - DefeatDungeonQuest/DefeatDungeonBossQuest: Travel to the dungeon specified in the quest.
    * - CatchShadowsQuest: Travel to Orre, the region where shadow Pokémon are found.
    * - CatchShiniesQuest: Ensure that the Shiny Charm and White Flute are active, if available.
    * - UseOakItemQuest: Equip the specified Oak Item, if available.
    * - UsePokeballQuest: Set the Caught filter to the specified Pokéball type (if the Caught filter exists), reverting when the quest is completed.
    * - ClearBattleFrontierQuest: Travel to the Battle Frontier location and enter it. (autobattlefrontier.user.js recommended)
    * - MineItemsQuest/MineLayersQuest: Open Underground modal.
    * - HarvestBerriesQuest/GainFarmPointsQuest: Open Farm modal.
    * - GainMoneyQuest: Travel to a profitable route meeting set criteria for money gain.
    * - GainTokensQuest: Travel to a profitable route meeting set criteria for token gain.
    * - CapturePokemonsQuest: Travel to a good route for catching the type, temporarily prioritize the type in the hatchery, or both.
    */
  // #region Constants
  const SCRIPT_NAME = 'questassistant'
  const QUEST_LIST = '#dailyQuestDisplayBody'
  const QUEST_LINE_LIST = '#questLineDisplayBody'
  const STORAGE_PREFIX = `${SCRIPT_NAME}.`
  const SOFT_EXIT_TIMEOUT = 30 * GameConstants.SECOND
  // #endregion Constants

  // #region Settings Definitions
  // log levels defined in LOG
  const LOG_LEVEL_KEY = 'logLevel' // observable defined above for TDZ safety
  // Enhanced Auto Clicker integration
  const AUTOCLICKER_KEY = 'autoclickerIntegration'
  const AUTOCLICKER_ENABLED = ko.observable(false)
  // Enhanced Auto Hatchery integration
  const AUTOHATCH_KEY = 'autohatchIntegration'
  const AUTOHATCH_ENABLED = ko.observable(false)
  // For CapturePokemonTypesQuest, specifies whether to focus on catches or hatches (different viability at different game stages)
  const CAPTURE_TYPE_STRATEGY_KEY = 'captureTypeStrategy'
  const CAPTURE_TYPE_STRATEGY = ko.observable('hatch') // 'hatch', 'catch', or 'both'
  // For CapturePokemonTypesQuest in hatch mode, specifies whether the action button sets filter or stuffs the hatchery queue
  const HATCH_ACTION_MODE_KEY = 'hatchActionMode'
  const HATCH_ACTION_MODE = ko.observable('filter') // 'filter' or 'queue'
  // For CapturePokemonTypesQuest in hatch mode, if fewer than this number of typed Pokémon are available,
  // temporarily remove non-type filters (0 to disable)
  const FILTER_RELAX_THRESHOLD_KEY = 'filterRelaxThreshold'
  const FILTER_RELAX_THRESHOLD = ko.observable(0)
  // For CapturePokemonTypesQuest in queue mode, how many matching Pokémon to keep queued at once
  const QUEUE_DEPTH_KEY = 'queueDepth'
  const QUEUE_DEPTH = ko.observable(3)
  // For CapturePokemonTypesQuest in catch mode, how much to favor routes with unclaimed rewards
  const CATCH_ROUTE_PRIORITY_KEY = 'catchRoutePriority'
  const CATCH_ROUTE_PRIORITY = ko.observable('balanced')
  const PRIORITY_MODES = {
    fastest: { weight: 0, strict: false },
    balanced: { weight: 0.5, strict: false },
    completion: { weight: 1, strict: true }
  }
  const priorityMode = () => PRIORITY_MODES[CATCH_ROUTE_PRIORITY()] ?? PRIORITY_MODES.balanced
  // Offset for low-health routes in scoring calculations
  const HEALTH_OFFSET_KEY = 'healthOffset'
  const HEALTH_OFFSET = ko.observable(0)

  function loadSettings () {
    LOG_LEVEL(loadSetting(LOG_LEVEL_KEY, LOG.INFO, v => v >= 0 && v <= LOG.DEBUG))
    AUTOCLICKER_ENABLED(loadSetting(AUTOCLICKER_KEY, false, v => typeof v === 'boolean'))
    AUTOHATCH_ENABLED(loadSetting(AUTOHATCH_KEY, false, v => typeof v === 'boolean'))
    CAPTURE_TYPE_STRATEGY(loadSetting(CAPTURE_TYPE_STRATEGY_KEY, 'hatch', ['hatch', 'catch', 'both']))
    HATCH_ACTION_MODE(loadSetting(HATCH_ACTION_MODE_KEY, 'filter', ['filter', 'queue']))
    FILTER_RELAX_THRESHOLD(loadSetting(FILTER_RELAX_THRESHOLD_KEY, 0, v => typeof v === 'number' && v >= 0))
    QUEUE_DEPTH(loadSetting(QUEUE_DEPTH_KEY, 3, v => typeof v === 'number' && v >= 0))
    CATCH_ROUTE_PRIORITY(loadSetting(CATCH_ROUTE_PRIORITY_KEY, 'balanced', ['fastest', 'balanced', 'completion']))
  }
  // #endregion Settings definitions

  // #region Initialization and Decoration

  // Game state observable, more reactive than a plain property
  // Mainly used to make sure we don't muck up dungeons, since a softlock is possible
  const gameState = ko.observable(null)
  // Also using this to track player location, since the game's own property is not observable
  const playerLocation = ko.observable(null)
  function startGameStateWatch () {
    const readLocation = () => `${player.region}:${player.subregion}:${player.route}:${player.town?.name ?? ''}`
    gameState(App.game.gameState)
    playerLocation(readLocation())
    const interval = setInterval(() => {
      const s = App.game.gameState
      if (s !== gameState()) gameState(s)
      const loc = readLocation()
      if (loc !== playerLocation()) playerLocation(loc)
    }, 500)
    log(LOG.DEBUG, `Game state watch interval ID ${interval}`)
  }
  const tracked = new Map() // quest -> { subs, ended }
  const specs = new Map() // quest -> spec
  // Button state-style map
  const STATE_STYLE = {
    unavailable: { css: 'btn-secondary', text: '\u{1F6C8}' }, // 🛈 info
    ready: { css: 'btn-success', text: '\u2713' },            // ✓ light check
    pending: { css: 'btn-warning', text: '\u23F3' },          // ⏳ hourglass
    applied: { css: 'btn-primary', text: '\u21A9' },          // ↩ return
    satisfied: { css: 'btn-light', text: '\u2714' }           // ✔ heavy check
  }
  function initQuestAssistant (attempts = 0) {
    const ready = App?.game?.quests?.currentQuests && document.querySelector(QUEST_LIST)
    if (!ready) {
      if (attempts > 100) {
        console.log('%cQuest Assistant failed to initialize after 100 attempts', 'color: red')
        return
      }
      setTimeout(() => initQuestAssistant(attempts + 1), 100)
      console.log('%cQuest Assistant not ready, retrying initialization in 100ms', 'color: gray')
      return
    }
    loadSettings()
    tryRestoreAutohatch()
    patchEggTick()
    startGameStateWatch()
    log(LOG.INFO, 'Quest Assistant initialized')
    try {
      initSettings()
    } catch (e) {
      log(LOG.ERROR, 'Settings UI unavailable:', e)
    }
    syncLifecycle()
    requestAnimationFrame(decorateAll)
    App.game.quests.currentQuests.subscribe(() => {
      log(LOG.DEBUG, 'Quest list changed; sweeping')
      syncLifecycle()
      requestAnimationFrame(decorateAll)
    })
    watchQuestLines()
    App.game.quests.questLines.subscribe(watchQuestLines)
  }

  function decorateAll () {
    questRows().forEach(row => decorate(row))
    decorateQuestLineAll()
  }
  function questRows () {
    return Array.from(document.querySelectorAll(`${QUEST_LIST} .row.no-gutters`)).filter(row => row.querySelector('.progress'))
  }

  // watch quest lines for step/state changes so decoration and lifecycle tracking stay in sync
  const questLineSubs = new Map() // questLine -> [subscriptions]
  function watchQuestLines () {
    App.game.quests.questLines().forEach(ql => {
      if (questLineSubs.has(ql)) return
      const onChange = () => {
        log(LOG.DEBUG, 'Quest line changed; sweeping')
        syncLifecycle()
        requestAnimationFrame(decorateAll)
      }
      questLineSubs.set(ql, [ql.state.subscribe(onChange), ql.curQuest.subscribe(onChange)])
      onChange()
    })
  }

  function liveQuestStep (ql) {
    const cur = ql.curQuestObject?.()
    return typeof cur?.isCompleted === 'function' ? cur : null
  }
  // quest(s) currently displayed for in-progress quest lines, flattened for lifecycle tracking
  function activeQuestLineQuests () {
    return App.game.quests.questLines()
      .filter(ql => ql.state() === QuestLineState.started)
      .flatMap(ql => {
        const cur = liveQuestStep(ql)
        return cur ? (cur.quests ?? [cur]) : [] // placeholder object used once the line has ended
      })
  }
  function questLineBlocks () {
    return Array.from(document.querySelectorAll(`${QUEST_LINE_LIST} .questLine`))
  }
  function decorateQuestLineAll () {
    questLineBlocks().forEach(decorateQuestLineBlock)
  }
  function decorateQuestLineBlock (block) {
    const ctx = ko.contextFor(block)
    const ql = ctx?.$data
    if (!ql) {
      log(LOG.WARN, 'Knockout context not found for quest line block:', block)
      return
    }
    const curQuestObj = liveQuestStep(ql)
    if (!curQuestObj) return
    const taskList = block.querySelector('.task-list')
    if (!taskList) return
    if (curQuestObj.quests) {
      // multi-quest step: each sub-quest's progress bar has its own knockout context
      taskList.querySelectorAll('.progress.mb-1').forEach(bar => {
        const subCtx = ko.contextFor(bar)
        const quest = subCtx?.$data
        if (quest) attachInlineButton(bar, quest, subCtx)
      })
    } else {
      // single-quest step: no nested binding, so the quest itself comes from curQuestObject()
      const bar = taskList.querySelector('.progress')
      if (bar) attachInlineButton(bar, curQuestObj, ctx)
    }
  }
  function attachInlineButton (bar, quest, ctx) {
    if (!bar || bar.parentElement?.classList.contains('qa-wrapper')) return false
    if (quest.isCompleted()) return false
    if (questAction(quest) === null) return false

    const wrapper = document.createElement('div')
    wrapper.className = 'qa-wrapper d-flex align-items-stretch mb-1'
    bar.classList.remove('mb-1')
    bar.parentElement.insertBefore(wrapper, bar)
    wrapper.appendChild(bar)
    bar.classList.add('flex-grow-1')

    const btn = document.createElement('button')
    btn.className = 'btn btn-sm p-0 qa-info-btn'
    btn.style.width = '10%'
    wrapper.appendChild(btn)

    ko.applyBindingsToNode(btn, actionButtonBindings(quest), ctx)
    ko.utils.domNodeDisposal.addDisposeCallback(bar, () => wrapper.remove())
    return true
  }
  function decorate (row) {
    if (!row) {
        log(LOG.WARN, 'Decorate called on empty element:', row)
        return false
    }
    if (row.querySelector('.qa-info-btn')) {
        log(LOG.DEBUG, 'Row already decorated:', row)
        return false
    }

    const ctx = ko.contextFor(row)
    if (!ctx) {
      log(LOG.WARN, 'Knockout context not found for row:', row)
      return false
    }
    const quest = ctx?.$data
    if (!quest) {
      log(LOG.WARN, 'Quest data not found for row:', row)
      return false
    }
    if (quest.isCompleted()) {
      log(LOG.DEBUG, 'Skipping decoration for completed quest:', quest)
      return false
    }
    if (questAction(quest) === null) {
      // questAction will log its own absence
      return false
    }
    const progressCol = row.querySelector('.col-10')
    if (!progressCol) {
      log(LOG.WARN, 'Progress column not found for row:', row)
      return false
    }
    progressCol.classList.replace('col-10', 'col-9')

    const newCol = document.createElement('div')
    newCol.classList.add('col-1')

    const btn = document.createElement('button')
    btn.className = 'btn btn-sm btn-block p-0 qa-info-btn'
    btn.textContent = '.' // placeholder, should be replaced by ko binding
    newCol.appendChild(btn)
    progressCol.insertAdjacentElement('afterend', newCol)

    log(LOG.DEBUG, 'Decorating quest row:', row)
    ko.applyBindingsToNode(btn, actionButtonBindings(quest), ctx)
    return true
  }
  // shared by daily quest rows and quest line progress bars
  function actionButtonBindings (quest) {
    return () => {
      const action = questAction(quest)
      if (!action) return {}
      const state = action.state()
      const style = STATE_STYLE[state] ?? STATE_STYLE['unavailable']
      return {
        visible: !quest.isCompleted(),
        tooltip: {
          title: action.tooltip(),
          trigger: 'hover',
          placement: 'top',
          html: true
        },
        css: Object.fromEntries(
          Object.values(STATE_STYLE)
            .filter(s => s.css)
            .map(s => [s.css, s.css === style.css])
        ),
        text: style.text,
        click: action.click
      }
    }
  }

  function endQuest (quest, reason) {
    const entry = tracked.get(quest)
    if (!entry || entry.ended) return
    entry.ended = true
    entry.subs.forEach(s => s.dispose())
    log(LOG.DEBUG, `quest ${reason}`, quest)
    questAction(quest)?.onEnd?.(reason)
    specs.delete(quest)
  }

  function syncLifecycle () {
    const current = new Set([...App.game.quests.currentQuests(), ...activeQuestLineQuests()])

    for (const quest of current) {
      if (tracked.has(quest)) continue
      const entry = { subs: [], ended: false }
      tracked.set(quest, entry)
      entry.subs.push(quest.isCompleted.subscribe(done => {
        if (done) endQuest(quest, 'completed')
      }))
      if (quest.isCompleted()) endQuest(quest, 'completed')
    }

    for (const quest of [...tracked.keys()]) {
      if (!current.has(quest)) {
        endQuest(quest, 'removed')
        tracked.delete(quest)
      }
    }
  }
  // #endregion Initialization and Decoration

  // #region Quest Handler Helpers
  function regionName (region) {
    const name = GameConstants.Region[region]
    if (name === undefined) {
      log(LOG.WARN, 'regionName could not resolve name for region:', region)
      return 'Unknown Region'
    }
    return name.charAt(0).toUpperCase() + name.slice(1)
  }
  class HandlerDeclined extends Error {}
  const decline = reason => { throw new HandlerDeclined(reason) }

  const inDungeon = () => gameState() === GameConstants.GameState.dungeon
  const canSoftExit = () => AUTOCLICKER_ENABLED() && EnhancedAutoClicker?.autoDungeonState?.()
  let activeTravel = null
  function deferredTravel () {
    // Travel helper to handle dungeon exits safely
    const pending = ko.observable(false)
    let sub = null
    let timeout = null

    const cancel = () => {
      sub?.dispose()
      sub = null
      clearTimeout(timeout)
      timeout = null
      pending(false)
      if (activeTravel === self) activeTravel = null
    }

    const self = {
      pending,
      blocked: () => inDungeon() && !canSoftExit(),
      cancel,
      run (action) {
        if (pending()) return
        // last click wins: cancel any previous active travel
        if (activeTravel && activeTravel !== self) {
          log(LOG.INFO, 'Superseding pending travel from another quest handler')
          activeTravel.cancel()
        }
        if (!inDungeon()) return action()
        if (!canSoftExit()) {
          log(LOG.WARN, 'Cannot travel while in a dungeon')
          return
        }
        if (!EnhancedAutoClicker?.autoDungeonTracker?.stopAfterFinishing) {
          // canSoftExit above guards the case where EnhancedAutoClicker doesn't exist
          log(LOG.INFO, 'Requesting soft dungeon exit')
          EnhancedAutoClicker?.toggleAutoDungeon(true)
        }
        activeTravel = self
        pending(true)
        sub = gameState.subscribe(() => {
          if (inDungeon()) return
          cancel()
          action()
        })
        timeout = setTimeout(() => {
          log(LOG.WARN, 'Soft dungeon exit timed out')
          cancel()
        }, SOFT_EXIT_TIMEOUT)
      }
    }
    return self
  }

  function moveToTown(townName) {
    MapHelper.moveToTown(townName)
    if (!MapHelper.isTownCurrentLocation(townName)) {
      log(LOG.ERROR, 'Failed to move to town:', townName)
      return false
    }
    log(LOG.INFO, 'Moved to town:', townName)
    return true
  }

  function moveToRoute(route, region) {
    MapHelper.moveToRoute(route, region)
    if (!MapHelper.isRouteCurrentLocation(route, region)) {
      log(LOG.ERROR, 'Failed to move to route:', route, 'in region:', region)
      return false
    }
    log(LOG.INFO, 'Moved to route:', route, 'in region:', region)
    return true
  }
  const autoAvailable = () => AUTOCLICKER_ENABLED() && typeof EnhancedAutoClicker !== 'undefined'

  const STATE = Object.freeze({
    PENDING: 'pending',
    UNAVAILABLE: 'unavailable',
    SATISFIED: 'satisfied',
    READY: 'ready',
    APPLIED: 'applied'
  })
  // #endregion Quest Handler Helpers
  
  // #region Scoring engine
  const healthOffset = () => HEALTH_OFFSET() * App.game.party.calculatePokemonAttack()
  // these weights can be adjusted globally through QuestAssistant.AREA_WEIGHTS,
  // but they're a little too plumbing for me to make them settings
  const AREA_WEIGHTS = {
    uncaughtPokemon: 1.0,
    uncaughtShinyPokemon: 0.5,
    missingAchievement: 0.3,
    missingResistant: 0.3
  }
  // magikarp jump sucks. we never want to go there.
  const excludeRoute = route => route.region === GameConstants.Region.alola 
    && route.subRegion === GameConstants.AlolaSubRegions.MagikarpJump
  
  function completionValue (route, names) {
    let v = 0
    const resistantEnabled = Settings
      .getSetting(`--${areaStatus[areaStatus.missingResistant]}`).isUnlocked()
    let uncaught = false
    let uncaughtShiny = false
    let missingResistant = false
    for (const name of names) {
      const p = App.game.party.getPokemonByName(name)
      if (!p) { uncaught = true; continue }
      if (!p.shiny) uncaughtShiny = true
      if (resistantEnabled && p.pokerus < GameConstants.Pokerus.Resistant) missingResistant = true
    }
    if (uncaught) v += AREA_WEIGHTS.uncaughtPokemon
    if (uncaughtShiny) v += AREA_WEIGHTS.uncaughtShinyPokemon
    if (missingResistant) v += AREA_WEIGHTS.missingResistant
    if (!RouteHelper.isAchievementsComplete(route.number, route.region)) {
      v += AREA_WEIGHTS.missingAchievement
    }
    return v
  }
  function scoreRoute (route, matches, opts = {}) {
    const { includeHeadbutt = true, useCatchRate = true, completionWeight = 0 } = opts
    // headbutt pokémon are always included in encounter tables, but might as well throw in the option
    const names = RouteHelper.getAvailablePokemonList(route.number, route.region, includeHeadbutt)
    const weights = RouteHelper.getAvailablePokemonWeightList(route.number, route.region, includeHeadbutt)
    const totalWeight = weights.reduce((s, w) => s + w, 0)
    if (totalWeight === 0) return null

    let matchingWeight = 0
    let catchWeighted = 0
    const matchingPokemon = []
    names.forEach((name, i) => {
      const data = PokemonHelper.getPokemonByName(name)
      if (!data || !matches(data, name)) return
      if (excludeRoute(route)) return
      matchingWeight += weights[i]
      if (useCatchRate) catchWeighted += weights[i] * PokemonFactory.catchRateHelper(data.catchRate, true)
      matchingPokemon.push(name)
    })
    if (matchingWeight === 0) return null

    const density = matchingWeight / totalWeight
    const meanCatch = useCatchRate ? catchWeighted / matchingWeight / 100 : 1
    const health = PokemonFactory.routeHealth(route.number, route.region) + healthOffset()
    const completion = completionValue(route, names)
    const base = density * meanCatch / health

    return {
      route,
      name: route.routeName,
      region: route.region,
      number: route.number,
      density,
      meanCatch,
      health,
      completion,
      matchingPokemon,
      score: base * (1 + completionWeight * completion)
    }
  }
  function rankRoutes (matches, opts) {
    const { strictCompletion = false } = opts
    return Routes.regionRoutes
      .filter(r => r.isUnlocked())
      .map(r => scoreRoute(r, matches, opts))
      .filter(Boolean)
      .sort((a, b) => {
        if (strictCompletion) {
          const ai = a.completion > 0 ? 1 : 0
          const bi = b.completion > 0 ? 1 : 0
          if (ai !== bi) return bi - ai
        }
        return b.score - a.score || a.route.orderNumber - b.route.orderNumber
      })
  }
  const matchesType = targetType => data =>
    data.type1 === targetType || data.type2 === targetType
  function rankRoutesByType (targetType, opts) {
    return rankRoutes(matchesType(targetType), opts)
  }
  // two helper functions for easier auditing
  function explainRanking (ranked, top = 8) {
    if (!ranked.length) return []
    const max = ranked[0].score
    return ranked.slice(0, top).map(r => ({
      route: r.name,
      region: GameConstants.Region[r.region],
      'type %': `${(r.density * 100).toFixed(1)}%`,
      'catch %': `${(r.meanCatch * 100).toFixed(0)}%`,
      health: r.health,
      rewards: r.completion > 0 ? r.completion.toFixed(1) : '-',
      relative: `${((r.score / max) * 100).toFixed(0)}%`,
      species: r.matchingPokemon.join(', ')
    }))
  }
  // example: QuestAssistant.explainRoutes(PokemonType.Water, { top: 20, completionWeight: 0 })
  function explainRoutes (targetType, opts = {}) {
    const { weight, strict } = priorityMode()
    const ranked = rankRoutesByType(targetType, {
      completionWeight: opts.completionWeight ?? weight,
      strictCompletion: opts.strictCompletion ?? strict
    })
    console.table(explainRanking(ranked, opts.top ?? 15))
    return ranked
  }
  // #endregion Scoring engine
  
  // #region Quest Handlers
  // #region DefeatDungeonQuest / DefeatDungeonBossQuest Handler
  const dungeonQuestHandler = quest => {
    const travel = deferredTravel()
    const dungeonTown = Object.values(TownList).find(town => town.constructor.name === 'DungeonTown' && town.dungeon.name === quest.dungeon)
    if (dungeonTown === undefined) {
      decline(`Could not find dungeon town for ${quest.dungeon}`)
    }

    const inDungeonTown = () => {
      playerLocation() // dependency: reevaluate when the player moves
      return MapHelper.isTownCurrentLocation(dungeonTown.name)
    }
    const canAffordEntry = () => App.game.wallet.currencies[GameConstants.Currency.dungeonToken]?.() >= dungeonTown.dungeon?.tokenCost
    const autoDungeonRunning = () => autoAvailable() && EnhancedAutoClicker.autoDungeonState()

    const startAutoDungeon = () => {
      if (!autoAvailable() || autoDungeonRunning()) return
      log(LOG.INFO, 'Engaging auto dungeon')
      // if the gym's running, the dungeon won't start
      if (EnhancedAutoClicker.autoGymState()) {
        EnhancedAutoClicker.toggleAutoGym()
        requestAnimationFrame(() => {
          EnhancedAutoClicker.toggleAutoDungeon()
        })
      } else {
        EnhancedAutoClicker.toggleAutoDungeon()
      }
    }

    const assess = () => {
      if (travel.pending()) {
        return { state: STATE.PENDING, tip: 'Finishing dungeon before traveling (click to cancel)' }
      }
      if (travel.blocked()) {
        return { state: STATE.UNAVAILABLE, tip: 'Cannot travel while in a dungeon' }
      }
      if (!MapHelper.accessToTown(dungeonTown.name)) {
        return { state: STATE.UNAVAILABLE, tip: `${dungeonTown.name} is not accessible yet.` }
      }
      if (!canAffordEntry()) {
        return { state: STATE.UNAVAILABLE, tip: `You do not have enough dungeon tokens to enter ${quest.dungeon}.` }
      }
      if (inDungeonTown()) {
        // with integration on, being parked in town but not farming is still actionable
        if (autoAvailable() && !autoDungeonRunning()) {
          return { state: STATE.READY, tip: `Start auto dungeon at ${quest.dungeon}` }
        }
        return { state: STATE.SATISFIED, tip: `You are currently ${AUTOCLICKER_ENABLED() ? 'clearing' : 'at'} ${quest.dungeon}.` }
      }
      return { state: STATE.READY, tip: `Travel to ${quest.dungeon} in ${regionName(quest.region)}` }
    }

    return {
      state: () => assess().state,
      tooltip: () => assess().tip,
      click: () => {
        if (travel.pending()) {
          log(LOG.INFO, `Canceling pending travel to ${dungeonTown.name}`)
          return travel.cancel()
        }
        if (inDungeonTown()) {
          startAutoDungeon()
          return
        }
        if (!MapHelper.accessToTown(dungeonTown.name) || !canAffordEntry()) {
          MapHelper.moveToTown(dungeonTown.name)
          return
        }
        travel.run(() => {
          if (!moveToTown(dungeonTown.name)) return
          if (inDungeonTown()) startAutoDungeon()
        })
      },
      onEnd: () => travel.cancel()
    }
  }
  // #endregion DefeatDungeonQuest / DefeatDungeonBossQuest Handler

  // #region DefeatGymQuest Handler
  const gymQuestHandler = quest => {
    // GymList entries are TownContent attached to their Town via addParent(), so
    // .parent.name is always the real town name - no need to guess from quest.gymTown.
    const gymTown = quest => GymList[quest.gymTown]?.parent?.name ?? quest.gymTown
    // Some towns (Elite Four rooms, Orre Colosseum, etc.) host multiple gyms, so the
    // autoclicker's gym dropdown needs to be pointed at the right one before enabling it.
    const gymsInTown = quest => (GymList[quest.gymTown]?.parent?.content ?? []).filter(e => e.constructor.name === 'Gym')
    const isMultiGymTown = quest => gymsInTown(quest).length > 1
    const gymRegion = region => {
      if (region < 0) return null
      if (region <= 9) return region // Kanto, Johto, Hoenn, Sinnoh, Unova, Kalos, Alola, Galar, Hisui, Paldea
      if (region === 10) return 0    // Orange gyms: Sevii Islands 4567
      if (region === 11) return 6    // Magikarp Jump: Alola
      if (region === 12) return 2    // Orre gyms: Hoenn
      return null
    }
    const travel = deferredTravel()

    const assess = () => {
      playerLocation() // dependency: reevaluate when the player moves
      const town = gymTown(quest)
      if (MapHelper.isTownCurrentLocation(town)) {
        return { state: STATE.SATISFIED, tip: `You are currently in ${town}` }
      }
      if (travel.pending()) {
        return { state: STATE.PENDING, tip: 'Finishing dungeon before traveling (click to cancel)' }
      }
      if (travel.blocked()) {
        return { state: STATE.UNAVAILABLE, tip: 'Cannot travel while in a dungeon' }
      }
      // If the town is not accessible, the user can still attempt travel
      // so display travel tooltip even when in 'unavailable' state
      // gym id ≠ region id, so we can't rely on quest.region for the tooltip
      const region = gymRegion(quest.region)
      const tip = `Travel to ${town} in ${regionName(region)}`
      if (!MapHelper.accessToTown(town)) {
        return { state: STATE.UNAVAILABLE, tip }
      }
      return { state: STATE.READY, tip }
    }

    return {
      state: () => assess().state,
      tooltip: () => assess().tip,
      click: () => {
        const town = gymTown(quest)
        if (travel.pending()) {
          log(LOG.INFO, `Canceling pending travel to ${town}`)
          return travel.cancel()
        }
        if (!MapHelper.accessToTown(town)) {
          MapHelper.moveToTown(town) // will fail, but lets the game toast the unlock requirement
          return
        }
        travel.run(() => {
          if (!moveToTown(town)) return
          // if enhancedautoclicker is available, toggle the gym thing
          if (AUTOCLICKER_ENABLED() && typeof EnhancedAutoClicker !== 'undefined') {
            // if multiple gyms share this town, make sure the right one is selected
            if (isMultiGymTown(quest)) {
              const currentIndex = EnhancedAutoClicker.autoGymSelect
              const targetIndex = gymsInTown(quest).map(g => g.town).indexOf(quest.gymTown)
              if (currentIndex !== targetIndex) {
                log(LOG.INFO, 'Changing selected gym from index', currentIndex, 'to', targetIndex)
                EnhancedAutoClicker.changeSelectedGym({ target: { value: targetIndex }})
                // changeSelectedGym only updates its internal state, not the <select> it was bound from
                const gymSelectEl = document.getElementById('auto-gym-select')
                if (gymSelectEl) gymSelectEl.value = targetIndex
              }
            }
            if (!EnhancedAutoClicker.autoGymState()) {
              EnhancedAutoClicker.toggleAutoGym()
            }
          }
        })
      },
      onEnd: () => travel.cancel()
    }
  }
  // #endregion DefeatGymQuest Handler

  // #region DefeatPokemonsQuest Handler
  const routeQuestHandler = quest => {
    const travel = deferredTravel()
    const atRoute = () => {
      playerLocation() // dependency: reevaluate when the player moves
      return MapHelper.isRouteCurrentLocation(quest.route, quest.region)
    }
    const autoClickRunning = () => autoAvailable() && EnhancedAutoClicker.autoClickState()
    const startAutoClick = () => {
      if (!autoAvailable() || autoClickRunning()) return
      log(LOG.INFO, 'Engaging auto click')
      EnhancedAutoClicker.toggleAutoClick()
    }

    const assess = () => {
      if (atRoute()) {
        // with integration on, being parked on the route but not clicking is still actionable
        if (autoAvailable() && !autoClickRunning()) {
          return { state: STATE.READY, tip: `Start auto click on route ${quest.route}` }
        }
        return { state: STATE.SATISFIED, tip: `You are currently on route ${quest.route} in ${regionName(quest.region)}` }
      }
      if (travel.pending()) {
        return { state: STATE.PENDING, tip: 'Finishing dungeon before traveling (click to cancel)' }
      }
      if (travel.blocked()) {
        return { state: STATE.UNAVAILABLE, tip: 'Cannot travel while in a dungeon' }
      }
      // we want to allow the user to attempt travel even if it's unavailable, so the game can toast with the unlock requirements
      const tip = `Travel to route ${quest.route} in ${regionName(quest.region)}`
      if (!MapHelper.accessToRoute(quest.route, quest.region)) {
        return { state: STATE.UNAVAILABLE, tip }
      }
      return { state: STATE.READY, tip }
    }

    return {
      state: () => assess().state,
      tooltip: () => assess().tip,
      click: () => {
        if (travel.pending()) {
          log(LOG.INFO, `Canceling pending travel to route ${quest.route} in ${regionName(quest.region)}`)
          return travel.cancel()
        }
        if (atRoute()) {
          startAutoClick()
          return
        }
        if (!MapHelper.accessToRoute(quest.route, quest.region)) {
          // let the game explain the unlock requirement since it's locked (should not actually move)
          MapHelper.moveToRoute(quest.route, quest.region)
          return
        }
        travel.run(() => {
          if (!moveToRoute(quest.route, quest.region)) return
          if (atRoute()) startAutoClick()
        })
      },
      onEnd: () => travel.cancel()
    }
  }
  // #endregion DefeatPokemonsQuest Handler

  // #region Frontier Quest Handler
  const frontierQuestHandler = _ => {
    const travel = deferredTravel()

    const assess = () => {
      playerLocation() // dependency: reevaluate when the player moves
      if (MapHelper.isTownCurrentLocation('Battle Frontier')) {
        return { state: STATE.SATISFIED, tip: 'You are currently in the Battle Frontier.' }
      }
      if (travel.pending()) {
        return { state: STATE.PENDING, tip: 'Finishing dungeon before traveling (click to cancel)' }
      }
      if (travel.blocked()) {
        return { state: STATE.UNAVAILABLE, tip: 'Cannot travel while in a dungeon' }
      }
      const tip = 'Travel to the Battle Frontier in Hoenn.'
      if (!MapHelper.accessToTown('Battle Frontier')) {
        return { state: STATE.UNAVAILABLE, tip }
      }
      return { state: STATE.READY, tip }
    }

    return {
      state: () => assess().state,
      tooltip: () => assess().tip,
      click: () => {
        if (travel.pending()) {
          log(LOG.INFO, 'Canceling pending travel to Battle Frontier')
          return travel.cancel()
        }
        if (!MapHelper.accessToTown('Battle Frontier')) {
          MapHelper.moveToTown('Battle Frontier') // trigger toast with unlock req
          return
        }
        travel.run(() => {
          if (!moveToTown('Battle Frontier')) return
          BattleFrontierRunner.start(true)
        })
      },
      onEnd: () => travel.cancel()
    }
  }
  // #endregion Frontier Quest Handler

  // #region Resource registry
  // Several quests compete for the same game settings: hatchery filters, pokeball filters.
  // The registry holds one snapshot per resource, taken by whoever claims it first, so a
  // second quest can never capture the first one's changes as its own "previous" state.
  // Last one out restores; anyone leaving while a sibling is still live hands off instead.
  const RESOURCE = Object.freeze(Object.fromEntries(
    Object.entries({
      HATCHERY_FILTERS: { key: 'hatcheryFilters', pending: 'hatchery.pendingRestore' },
      SHADOW_FILTER: { key: 'shadowFilter', pending: 'shadowFilter.pendingRestore' },
      CAUGHT_FILTER: { key: 'caughtFilter', pending: 'pokeball.pendingRestore' },
      QA_BALL_FILTER: { key: 'qaBallFilter', pending: null } // owned by QA, nothing to restore
    }).map(([name, def]) => [name, Object.freeze(def)])
  ))

  const resourceOwners = new Map() // key -> { quest, snapshot }
  const resourceVersion = ko.observable(0)
  const bumpResourceVersion = () => resourceVersion(resourceVersion() + 1)

  function ownsResource (key, quest) {
    resourceVersion() // dependency: buttons repaint on claim, handoff and release
    return resourceOwners.get(key)?.quest === quest
  }

  function resourceSnapshot (key) {
    resourceVersion()
    return resourceOwners.get(key)?.snapshot
  }

  // Same-type quests that are live right now, daily list and quest lines alike.
  // specs.has excludes quests whose handler declined, since those never release.
  function concurrentQuestsOfType (quest) {
    return [...App.game.quests.currentQuests(), ...activeQuestLineQuests()]
      .filter(q => q !== quest && questType(q) === questType(quest) && !q.isCompleted() && specs.has(q))
  }

  function claimResource (key, quest, takeSnapshot) {
    const held = resourceOwners.get(key)
    if (!held) {
      resourceOwners.set(key, { quest, snapshot: takeSnapshot() })
    } else if (held.quest !== quest) {
      log(LOG.INFO, `${key}: taking over from another quest`)
      held.quest = quest // snapshot deliberately not retaken
    }
    bumpResourceVersion()
    return resourceOwners.get(key).snapshot
  }

  function releaseResource (key, quest, restore) {
    const held = resourceOwners.get(key)
    if (!held || held.quest !== quest) return false // someone else took over; not ours to restore
    const others = concurrentQuestsOfType(quest)
    if (others.length) {
      log(LOG.INFO, `${key}: handing off to another ${questType(quest)}`)
      held.quest = others[0]
      bumpResourceVersion()
      return false
    }
    restore(held.snapshot)
    resourceOwners.delete(key)
    bumpResourceVersion()
    return true
  }
  // #endregion Resource registry

  // #region Shadow Quest Handler
  function restoreShadowFilter () {
    const stored = loadSetting(RESOURCE.SHADOW_FILTER.pending, { uuid: null, previous: null })
    if (!stored.uuid) {
      log(LOG.INFO, 'No pending shadow filter restore')
      return false
    }
    const filter = App.game.pokeballFilters.list().find(f => f.uuid === stored.uuid)
    if (!filter) {
      log(LOG.WARN, 'Shadow filter no longer exists; discarding pending restore')
      clearSetting(RESOURCE.SHADOW_FILTER.pending)
      return false
    }
    filter.enabled(stored.previous)
    clearSetting(RESOURCE.SHADOW_FILTER.pending)
    log(LOG.INFO, `Restored shadow filter enabled=${stored.previous}`)
    return true
  }
  const shadowQuestHandler = quest => {
    const travel = deferredTravel()
    const destination = SubRegions.getSubRegions(GameConstants.Region.hoenn).find(sr => sr.name === 'Orre')?.startTown
    if (!destination) decline('Orre start town not found')

    const inOrre = () => {
      playerLocation() // dependency: reevaluate when the player moves
      return player.region === GameConstants.Region.hoenn &&
        player.subregion === GameConstants.HoennSubRegions.Orre
    }
    const unlocked = () => SubRegions.isSubRegionUnlocked(GameConstants.Region.hoenn, GameConstants.HoennSubRegions.Orre)

    const findShadowFilters = () => App.game.pokeballFilters.list()
      .filter(x => x.options?.caughtShadow?.value === true)
    const shadowFilter = () => findShadowFilters()[0]
    const found = findShadowFilters()
    if (found.length === 0) {
      log(LOG.DEBUG, 'No Caught Shadow filter found; filter management disabled')
    } else if (found.length > 1) {
      log(LOG.WARN, `Found ${found.length} Caught Shadow filters; managing the first one only:`, found.map(f => f.name()))
    }

    const stored = loadSetting(RESOURCE.SHADOW_FILTER.pending, { uuid: null, previous: null })
    if (stored.uuid) {
      const f = App.game.pokeballFilters.list().find(x => x.uuid === stored.uuid)
      if (f && f.enabled() === true) {
        claimResource(RESOURCE.SHADOW_FILTER.key, quest, () => stored)
        log(LOG.INFO, 'Recovered pending shadow filter restore')
      } else {
        log(LOG.DEBUG, 'Discarding stale shadow filter restore')
        clearSetting(RESOURCE.SHADOW_FILTER.pending)
      }
    }

    // ownership AND the value check: after a handoff the successor owns it and, since every
    // shadow quest wants the same value, still reads as applied
    const filterApplied = () => {
      if (!ownsResource(RESOURCE.SHADOW_FILTER.key, quest)) return false
      const snap = resourceSnapshot(RESOURCE.SHADOW_FILTER.key)
      return App.game.pokeballFilters.list().find(x => x.uuid === snap?.uuid)?.enabled() === true
    }
    const filterActionable = () => {
      const f = shadowFilter()
      return f !== undefined && !f.enabled()
    }

    const applyFilter = () => {
      const f = shadowFilter()
      if (!f || f.enabled()) return
      // snapshot must be taken before the write
      const record = claimResource(RESOURCE.SHADOW_FILTER.key, quest,
        () => ({ uuid: f.uuid, previous: f.enabled() }))
      f.enabled(true)
      saveSetting(RESOURCE.SHADOW_FILTER.pending, record)
      log(LOG.INFO, 'Enabled Caught Shadow pokéball filter')
    }

    const restore = () => {
      releaseResource(RESOURCE.SHADOW_FILTER.key, quest, () => {
        restoreShadowFilter() // clears the pending key itself
      })
    }

    const assess = () => {
      if (travel.pending()) {
        return { state: STATE.PENDING, tip: 'Finishing dungeon before traveling (click to cancel)' }
      }
      if (!unlocked()) {
        return { state: STATE.UNAVAILABLE, tip: 'Orre is not accessible yet' }
      }
      if (filterApplied()) {
        return { state: STATE.APPLIED, tip: 'Caught Shadow filter enabled; restores your setting when the quest ends' }
      }
      if (!inOrre()) {
        if (travel.blocked()) {
          return { state: STATE.UNAVAILABLE, tip: 'Cannot travel while in a dungeon' }
        }
        return { state: STATE.READY, tip: 'Travel to Orre' }
      }
      if (filterActionable()) {
        return { state: STATE.READY, tip: 'Enable your Caught Shadow pokéball filter' }
      }
      return {
        state: STATE.SATISFIED,
        tip: shadowFilter() === undefined
          ? 'You are in Orre. Clear a dungeon to catch Shadow Pokémon. Add a Caught Shadow pokéball filter to have this managed for you.'
          : 'You are in Orre with the Caught Shadow filter active. Clear a dungeon to catch Shadow Pokémon.'
      }
    }

    return {
      state: () => assess().state,
      tooltip: () => assess().tip,
      click: () => {
        if (travel.pending()) {
          log(LOG.INFO, 'Canceling pending travel to Orre')
          if (filterApplied()) restore()
          return travel.cancel()
        }
        const { state } = assess()
        if (state === STATE.APPLIED) return restore()
        applyFilter()
        if (inOrre()) return
        travel.run(() => {
          if (inOrre()) return
          moveToTown(destination)
        })
      },
      onEnd: () => {
        travel.cancel()
        restore()
      }
    }
  }
  // #endregion Shadow Quest Handler

  // #region UsePokeball Quest Handler
  // this one's got some state
  const usePokeballQuestHandler = quest => {
    const balls = ['Poké Ball', 'Great Ball', 'Ultra Ball']

    // only act when the last filter slot is a sole 'Caught' filter
    const caughtFilter = () => {
      const lastFilter = App.game.pokeballFilters.list().slice(-1)[0]
      const keys = Object.keys(lastFilter?.options ?? {})
      if (keys.length === 1 && keys[0] === 'caught') {
        return lastFilter
      }
      return null
    }
    const currentBall = () => caughtFilter()?.ball()

    // snapshot is { filter, ball }: filter is a live KO object, so only `ball` is persisted
    const stored = loadSetting(RESOURCE.CAUGHT_FILTER.pending, { previous: -1, applied: -1 })
    if (stored.previous !== -1 && caughtFilter() && caughtFilter().ball() === stored.applied) {
      // hoping the user hasn't reordered filters between saving and restoring
      claimResource(RESOURCE.CAUGHT_FILTER.key, quest,
        () => ({ filter: caughtFilter(), ball: stored.previous }))
      log(LOG.INFO, `Recovered pending restore: ${balls[stored.previous]}`)
    } else if (stored.previous !== -1) {
      log(LOG.DEBUG, 'Discarding stale pending restore')
      clearSetting(RESOURCE.CAUGHT_FILTER.pending)
    }

    // restore against the snapshotted filter object, not a fresh lookup: the user may
    // have reordered their filters since we took it
    const restoreSnapshot = s => {
      if (!s) return
      log(LOG.INFO, `Restoring previous ball: ${balls[s.ball]}`)
      s.filter?.ball(s.ball)
      clearSetting(RESOURCE.CAUGHT_FILTER.pending)
    }
    const owned = () => ownsResource(RESOURCE.CAUGHT_FILTER.key, quest)
    const snap = () => resourceSnapshot(RESOURCE.CAUGHT_FILTER.key)
    const state = () => {
      if (!caughtFilter()) return STATE.UNAVAILABLE
      // ownership AND the value check: a handoff from a quest wanting a different ball
      // leaves us owning a filter that does not match, which is READY rather than APPLIED
      if (owned() && currentBall() === quest.pokeball) return STATE.APPLIED
      if (currentBall() === quest.pokeball) return STATE.SATISFIED
      return STATE.READY
    }
    return {
      state,
      tooltip: () => {
        switch (state()) {
          case STATE.UNAVAILABLE:
            return "Add a 'Caught' filter in the last slot to enable this feature"
          case STATE.APPLIED:
            return `Caught filter set to ${balls[quest.pokeball]}; will reset to ${balls[snap().ball]} when done`
          case STATE.SATISFIED:
            return `Caught filter already set to ${balls[quest.pokeball]}`
          default:
            return `Switch 'Caught' filter to ${balls[quest.pokeball]}`
        }
      },
      click: () => {
        const handlerState = state()
        if (handlerState === STATE.UNAVAILABLE || handlerState === STATE.SATISFIED) return
        const filter = caughtFilter()
        if (owned() && filter.ball() === quest.pokeball) {
          log(LOG.INFO, `Restoring previous ball on click: ${balls[snap().ball]}`)
          releaseResource(RESOURCE.CAUGHT_FILTER.key, quest, restoreSnapshot)
          return
        }
        const record = claimResource(RESOURCE.CAUGHT_FILTER.key, quest,
          () => ({ filter, ball: filter.ball() }))
        saveSetting(RESOURCE.CAUGHT_FILTER.pending, {
          previous: record.ball,
          applied: quest.pokeball
        })
        filter.ball(quest.pokeball)
      },
      onEnd: reason => {
        log(LOG.DEBUG, `usePokeballQuestHandler onEnd: ${reason}`)
        releaseResource(RESOURCE.CAUGHT_FILTER.key, quest, restoreSnapshot)
      }
    }
  }
  // #endregion UsePokeball Quest Handler

  // #region GainGems Quest Handler
  const gemQuestHandler = quest => {
    const typeStr = PokemonType[quest.type]
    const plateName = UndergroundTrading.availableItemsToTrade.find(item => item.type === quest.type)?.itemName
    if (!plateName) {
      decline(`No ${typeStr} plates available for trade`)
    }
    const plateNameStr = plateName?.replaceAll('_', ' ') // Draco_plate -> Draco plate
    const plates = n => `${n}× ${plateNameStr}` // n -> n× Draco plate
    const gemsNeeded = () => quest.amount - (quest.focus() - quest.initial())
    const platesToSell = () => Math.max(1, Math.ceil(gemsNeeded() / GameConstants.PLATE_VALUE))
    const availablePlates = () => player.itemList[plateName]?.() ?? 0

    const assess = () => {
      const avail = availablePlates()
      const sell = platesToSell()
      if (avail >= sell) {
        return {
          state: STATE.READY,
          tip: `Sell ${plates(sell)} for ${sell * GameConstants.PLATE_VALUE} ${typeStr} gems`
        }
      }
      if (avail === 0) {
        return {
          state: STATE.UNAVAILABLE,
          tip: `You have no ${plateNameStr} to sell for ${typeStr} gems.`
        }
      }
      return {
        state: STATE.UNAVAILABLE,
        tip: `You need ${plates(sell)}, but only have ${avail}.`
      }
    }

    return {
      state: () => assess().state,
      tooltip: () => assess().tip,
      click: () => {
        if (assess().state === STATE.READY) {
          // cache existing selections
          const previousSellAmount = UndergroundTrading.sellAmount
          const previousTradeFromItem = UndergroundTrading.selectedTradeFromItem
          try {
            UndergroundTrading.sellAmount = platesToSell()
            UndergroundTrading.selectedTradeFromItem = UndergroundTrading.availableItemsToTrade.find(item => item.type === quest.type)
            UndergroundTrading.sell()
          } finally {
            // restore previous selection after selling
            UndergroundTrading.selectedTradeFromItem = previousTradeFromItem
            UndergroundTrading.sellAmount = previousSellAmount
          }
          log(LOG.INFO, `Sold ${plates(platesToSell())} for ${platesToSell()*GameConstants.PLATE_VALUE} ${typeStr} gems`)
        }
      }
    }
  }
  // #endregion GainGems Quest Handler

  // #region UseOakItem Quest Handler
  const oakItemQuestHandler = (quest) => {
    const item = App.game.oakItems.itemList[quest.item]
    if (!item) {
      decline(`${quest.item} not found in oakItems.itemList`)
    }
    const slotAvailable = () => App.game.oakItems.activeCount() < App.game.oakItems.maxActiveCount()
    return {
      state: () => {
        if (App.game.oakItems.isActive(item.name)) {
          return STATE.SATISFIED
        }
        if (!App.game.oakItems.isUnlocked(item.name)) {
          // the game shouldn't assign quests for items that aren't unlocked, but just in case
          return STATE.UNAVAILABLE
        }
        if (slotAvailable()) {
          return STATE.READY
        }
        return STATE.UNAVAILABLE
      },
      tooltip: () => {
        if (App.game.oakItems.isActive(item.name)) {
          return `${item.displayName} is equipped.`
        }
        if (!App.game.oakItems.isUnlocked(item.name)) {
          return `${item.displayName} is not unlocked.`
        }
        if (slotAvailable()) {
          return `Equip ${item.displayName} into free slot.`
        }
        return `Can't equip ${item.displayName}: ${App.game.oakItems.activeCount()} of ${App.game.oakItems.maxActiveCount()} slots are occupied`
      },
      click: () => {
        if (App.game.oakItems.isActive(item.name) || !App.game.oakItems.isUnlocked(item.name) || !slotAvailable()) return
        App.game.oakItems.activate(item.name)
      }
    }
  }
  // #endregion UseOakItem Quest Handler

  // #region CapturePokemonTypes Quest Handler
  // #region CapturePokemonTypes helpers
  function subscriptionBag () {
    const subs = []
    return {
      add: (...s) => subs.push(...s),
      dispose: () => { subs.forEach(s => s.dispose()); subs.length = 0 }
    }
  }
  function catchMode ({ quest, typeStr, remaining }) {
    const travel = deferredTravel()
    const QA_FILTER_PREFIX = 'QA'
    const findQAFilter = () => App.game.pokeballFilters.list()
      .find(f => f._name?.().startsWith(QA_FILTER_PREFIX))

    const ranking = ko.observable([])
    const refreshRanking = () => {
      const { weight, strict } = priorityMode()
      const ranked = rankRoutesByType(quest.type, { completionWeight: weight, strictCompletion: strict })
      ranking(ranked)
      if (LOG_LEVEL() >= LOG.DEBUG && ranked.length) {
        log(LOG.DEBUG, `Top ${typeStr} routes (${CATCH_ROUTE_PRIORITY()}):`)
        console.table(explainRanking(ranked, 5))
      }
    }
    const currentEntry = () => {
      playerLocation() // dependency: reevaluate when the player moves
      return ranking().find(r => MapHelper.isRouteCurrentLocation(r.number, r.region))
    }
    const best = () => ranking()[0]
    
    const filterActive = () => {
      const f = findQAFilter()
      return f !== undefined && f.enabled() && f.options?.pokemonType?.value === quest.type
    }
    // ownership AND the value check, as elsewhere
    const filterOwned = () => ownsResource(RESOURCE.QA_BALL_FILTER.key, quest) && filterActive()
    // once we've committed to a route, demand a bigger gain before nudging the player to move again
    const moveThreshold = () => filterOwned() ? 1.4 : 1.15
    const shouldMove = () => {
      const b = best()
      return b !== undefined && b.score > (currentEntry()?.score ?? 0) * moveThreshold()
    }

    const applyBallFilter = () => {
      const f = findQAFilter()
      if (!f) return false
      claimResource(RESOURCE.QA_BALL_FILTER.key, quest, () => null) // ours; nothing to snapshot
      if (f.options?.pokemonType) f.options.pokemonType.value = quest.type
      f._name(`${QA_FILTER_PREFIX} (${typeStr})`)
      f.enabled(true)
      return true
    }

    const releaseBallFilter = () => {
      releaseResource(RESOURCE.QA_BALL_FILTER.key, quest, () => {
        const f = findQAFilter()
        if (!f) return
        f.enabled(false)
        f._name(QA_FILTER_PREFIX)
        log(LOG.INFO, 'Released QuestAssistant pokéball filter')
      })
    }
    
    const assess = () => {
      if (travel.pending()) {
        return { state: STATE.PENDING, tip: 'Finishing dungeon before traveling: click to cancel' }
      }
      if (!findQAFilter()) {
        return {
          state: STATE.UNAVAILABLE,
          tip: `Add a pokéball filter named "${QA_FILTER_PREFIX}" with a Pokémon Type option to enable catch mode`
        }
      }
      const b = best()
      if (b === undefined) {
        return { state: STATE.UNAVAILABLE, tip: `No unlocked route has ${typeStr} encounters` }
      }
      if (filterOwned() && !shouldMove()) {
        const here = currentEntry()
        return {
          state: STATE.APPLIED,
          tip: here
            ? `Catching ${typeStr} on ${here.name} (${remaining()} to go): click to restore your filter`
            : `Filter set to ${typeStr} (${remaining()} to go): click to restore your filter`
        }
      }
      if (travel.blocked()) {
        return { state: STATE.UNAVAILABLE, tip: 'Cannot travel while in a dungeon' }
      }
      const pct = Math.round(b.density * 100)
      return {
        state: STATE.READY,
        tip: `Catch ${typeStr} on ${b.name} (${pct}% of encounters${b.completion > 0 ? ', rewards unclaimed' : ''}, ${remaining()} to go)`
      }
    }
    const click = (state) => {
      if (travel.pending()) return travel.cancel()
      if (state === STATE.APPLIED) return releaseBallFilter()
      if (state === STATE.UNAVAILABLE) return
      applyBallFilter()
      const b = best()
      if (b === undefined || !shouldMove()) return
      return travel.run(() => moveToRoute(b.number, b.region))
    }
    const bag = subscriptionBag()

    if (CAPTURE_TYPE_STRATEGY() !== 'hatch') refreshRanking() // 'catch' or 'both'
    bag.add(
      CATCH_ROUTE_PRIORITY.subscribe(refreshRanking),
      DayCycle.currentDayCyclePart.subscribe(refreshRanking),
      Weather.currentWeather.subscribe(refreshRanking)
    )
    return {
      label: 'Catch',
      assess,
      click,
      release: () => { travel.cancel(); releaseBallFilter() },
      dispose: bag.dispose
    }
  }

  function hatchFilterMode ({ quest, typeStr, remaining }) {
    const bag = subscriptionBag()
    const BREEDING_DEFAULTS = {
      breedingType2Filter: [],
      breedingRegionFilter: [],
      breedingCategoryFilter: [],
      breedingShinyFilter: -1,
      breedingPokerusFilter: -1,
      breedingUniqueTransformationFilter: 'all',
      breedingHideAltFilter: false
    }
    const MANAGED = ['breedingType1Filter', ...Object.keys(BREEDING_DEFAULTS)]
    const getFilter = name => Settings.getSetting(name)?.value
    const setFilter = (name, val) => {
      const s = Settings.getSetting(name)
      if (s) s.value = val
      else log(LOG.WARN, `Unknown hatchery filter setting: ${name}`)
    }
    const snapshot = names => Object.fromEntries(names.map(name => [name, getFilter(name)]))
    const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b) // maybe pop this one out to module scope, it's a generic deep equality check

    // Pokémon the hatchery would currently let you queue/breed, with all active filters applied
    const availableToHatch = () => App.game.party.caughtPokemon.filter(p => p.isHatchableFiltered())

    const RELAX_POLL_MS = 2000
    let relaxTimer = null

    const alreadyRelaxed = () => Object.entries(BREEDING_DEFAULTS).every(([n, v]) => sameValue(getFilter(n), v))
    const stopRelaxWatch = () => {
      clearInterval(relaxTimer)
      relaxTimer = null
    }
    const relaxIfNeeded = () => {
      const threshold = FILTER_RELAX_THRESHOLD()
      if (threshold <= 0) return stopRelaxWatch()
      if (alreadyRelaxed()) {
        log(LOG.DEBUG, 'Other hatchery filters already at defaults; stopping relax watch')
        return stopRelaxWatch()
      }
      
      const n = availableToHatch().length
      log(LOG.DEBUG, `relax check: threshold=${threshold} relaxed=${alreadyRelaxed()} n=${availableToHatch().length}`)
      if (threshold <= n) return

      log(LOG.INFO, `${n} ${typeStr} hatchable, below threshold of ${threshold}: relaxing other hatchery filters`)
      Object.entries(BREEDING_DEFAULTS).forEach(([n, v]) => setFilter(n, v))
      stopRelaxWatch()
      // the persisted `applied` snapshot is now stale; refresh it or the reload staleness
      // check will reject a restore that is still valid
      const previous = resourceSnapshot(RESOURCE.HATCHERY_FILTERS.key)
      if (previous) {
        saveSetting(RESOURCE.HATCHERY_FILTERS.pending, { previous, applied: snapshot(MANAGED) })
      }
    }
    const startRelaxWatch = () => {
      if (relaxTimer === null) {
        relaxTimer = setInterval(relaxIfNeeded, RELAX_POLL_MS)
        log(LOG.INFO, 'Monitoring hatchery count; will relax filters if needed')
      }
    }
    
    const stored = loadSetting(RESOURCE.HATCHERY_FILTERS.pending, { previous: null, applied: null })
    if (stored.applied && Object.entries(stored.applied).every(([n, v]) => sameValue(getFilter(n), v))) {
      claimResource(RESOURCE.HATCHERY_FILTERS.key, quest, () => stored.previous)
      startRelaxWatch()
      log(LOG.INFO, 'Recovered pending hatchery filter restore')
    } else if (stored.applied) {
      log(LOG.DEBUG, 'Discarding stale pending hatchery filter restore')
      clearSetting(RESOURCE.HATCHERY_FILTERS.pending)
    }
    bag.add(FILTER_RELAX_THRESHOLD.subscribe(v => {
        if (v > 0 && ownsResource(RESOURCE.HATCHERY_FILTERS.key, quest)) startRelaxWatch()
        // relax watch is self-clearing, so no need to stop it here if the threshold goes to 0
    }))
    
    const typeFilterSet = () => sameValue(getFilter('breedingType1Filter'), [quest.type])
    const apply = () => {
      const before = claimResource(RESOURCE.HATCHERY_FILTERS.key, quest, () => snapshot(MANAGED))
      setFilter('breedingType1Filter', [quest.type])
      saveSetting(RESOURCE.HATCHERY_FILTERS.pending, { previous: before, applied: snapshot(MANAGED) })
      startRelaxWatch()
    }
    const restore = () => {
      stopRelaxWatch()
      releaseResource(RESOURCE.HATCHERY_FILTERS.key, quest, () => {
        restoreHatcheryFilters() // clears the pending key itself
      })
    }

    const assess = () => {
      if (!App.game.breeding.canAccess()) {
        return { state: STATE.UNAVAILABLE, tip: 'The hatchery is not available yet' }
      }
      if (typeFilterSet()) {
        // ownership AND the value check: a handoff from a quest wanting a different type
        // leaves the filter reading as someone else's, so fall through to READY
        return ownsResource(RESOURCE.HATCHERY_FILTERS.key, quest)
          ? {
              state: STATE.APPLIED,
              tip: `Hatchery filtered to ${typeStr}; restores your filters when the quest ends (${remaining()} to go)`
            }
          : { state: STATE.SATISFIED, tip: `Hatchery already filtered to ${typeStr}` }
      }
      const threshold = FILTER_RELAX_THRESHOLD()
      const willRelax = threshold > 0 && availableToHatch().length < threshold
      return {
        state: STATE.READY,
        tip: `Filter the hatchery to ${typeStr} types (${remaining()} to go)${willRelax ? ', relaxing other filters' : ''}`
      }
    }
    const click = (state) => {
      if (state === STATE.UNAVAILABLE || state === STATE.SATISFIED) return
      if (state === STATE.APPLIED) return restore()
      apply()
    }
    return {
      label: 'Hatchery Filter',
      assess,
      click,
      release: restore,
      dispose: bag.dispose
    }
  }

  // queue mode helpers
  const PENDING_AUTOHATCH_KEY = 'autoHatch.pendingRestore'
  const eggTickHandlers = new Set()
  let eggTickPatched = false
  function patchEggTick () {
    if (eggTickPatched) return
    eggTickPatched = true
    const original = Breeding.prototype.progressEggs
    Breeding.prototype.progressEggs = function (...args) {
      const result = original.apply(this, args)
      if (App.game.breeding.canAccess()) {
        eggTickHandlers.forEach(fn => {
          try {
            fn()
          } catch (e) {
            log(LOG.ERROR, 'Egg tick handler threw:', e)
          }
        })
      }
      return result
    }
  }
  function hatchQueueMode (ctx) {
    const { quest, typeStr, remaining } = ctx
    const queueWatching = ko.observable(false)
    let suppressedAutoHatch = false

    const autoHatchPresent = () => typeof toggleAutoHatch === 'function' && typeof hatchState !== 'undefined'
    const autoHatchRunning = () => autoHatchPresent() && hatchState
    const autoHatchManageable = () => autoHatchPresent() && AUTOHATCH_ENABLED()
    const setAutoHatch = on => {
      if (!autoHatchManageable() || hatchState === on) return
      toggleAutoHatch({ target: document.getElementById('auto-hatch-start') })
      saveSetting(PENDING_AUTOHATCH_KEY, !on)
      log(LOG.INFO, `Enhanced Auto Hatchery ${on ? 're-enabled' : 'suspended'} by QuestAssistant`)
    }

    const typeMatches = p => pokemonMap[p.name]?.type?.includes(quest.type)
    const candidates = () => App.game.party.caughtPokemon
      .filter(p => typeMatches(p) && p.isHatchable())
      .sort((a, b) => (pokemonMap[a.name].eggCycles ?? 0) - (pokemonMap[b.name].eggCycles ?? 0))

    const hatchReady = () => {
      for (let i = App.game.breeding.eggSlots - 1; i >= 0; i--) {
        App.game.breeding.hatchPokemonEgg(i)
      }
    }

    const stopQueueWatch = () => {
      eggTickHandlers.delete(onEggTick)
      queueWatching(false)
      if (suppressedAutoHatch) {
        setAutoHatch(true)
        suppressedAutoHatch = false
      }
    }

    function onEggTick () {
      if (remaining() <= 0) return stopQueueWatch()
      const breeding = App.game.breeding
      const depth = Math.min(QUEUE_DEPTH(), breeding.usableQueueSlots())

      // At depth 0 the queue stays empty, which is exactly when Enhanced Auto Hatchery
      // claims free slots with its own pick, so take hatching over while that's the case.
      if (QUEUE_DEPTH() === 0 && autoHatchRunning() && autoHatchManageable()) {
        setAutoHatch(false)
        suppressedAutoHatch = true
      } else if (suppressedAutoHatch && QUEUE_DEPTH() > 0) {
        setAutoHatch(true)
        suppressedAutoHatch = false
      }
      if (!autoHatchRunning()) hatchReady()

      let budget = remaining()
      for (const p of candidates()) {
        if (budget <= 0) break
        if (!breeding.hasFreeEggSlot() && breeding.queueList().length >= depth) break
        if (breeding.addPokemonToHatchery(p)) {
          log(LOG.DEBUG, `Sent ${p.name} to the cornfield`)
          budget--
        }
      }
    }

    const startQueueWatch = () => {
      if (queueWatching()) return
      if (QUEUE_DEPTH() === 0 && autoHatchRunning() && !AUTOHATCH_ENABLED()) {
        log(LOG.WARN, 'Queue depth 0 with Auto Hatch running: enable the Auto Hatchery integration setting or it will claim free slots first')
      }
      queueWatching(true)
      eggTickHandlers.add(onEggTick)
      onEggTick()
    }
    const assess = () => {
      if (!App.game.breeding.canAccess()) {
        return { state: STATE.UNAVAILABLE, tip: 'The hatchery is not available yet' }
      }
      if (queueWatching()) {
        return {
          state: STATE.APPLIED,
          tip: `Keeping the hatchery stocked with ${typeStr} (${remaining()} to go): click to stop`
        }
      }
      const pool = candidates().length
      if (pool === 0) {
        return { state: STATE.UNAVAILABLE, tip: `No hatchable ${typeStr} in your party` }
      }
      return {
        state: STATE.READY,
        tip: QUEUE_DEPTH() === 0
          ? `Hatch ${typeStr} as slots free up (${pool} available, ${remaining()} to go)`
          : `Hatch ${typeStr}, keeping ${QUEUE_DEPTH()} queued (${pool} available, ${remaining()} to go)`
      }
    }
    const click = (state) => {
      if (state === STATE.UNAVAILABLE || state === STATE.SATISFIED) return
      return queueWatching() ? stopQueueWatch() : startQueueWatch()
    }
    return {
      label: 'Hatchery Queue',
      assess,
      click,
      release: stopQueueWatch,
      dispose: () => {}
    }
  }
  // filter mode helpers
  // hoisted this function out of captureTypesQuestHandler so window.QuestAssistant can expose it
  // call QuestAssistant.restoreHatcheryFilters() to restore the saved hatchery filters if something goes wrong
  function restoreHatcheryFilters () {
    const stored = loadSetting(RESOURCE.HATCHERY_FILTERS.pending, { previous: null })
    if (!stored.previous) {
      log(LOG.INFO, 'No pending hatchery filter restore')
      return false
    }
    Object.entries(stored.previous).forEach(([name, val]) => {
      const s = Settings.getSetting(name)
      if (s) s.value = val
    })
    clearSetting(RESOURCE.HATCHERY_FILTERS.pending)
    log(LOG.INFO, 'Restored hatchery filters from saved snapshot')
    return true
  }

  // hoisted so init can access
  function tryRestoreAutohatch (attempts = 0) {
    if (!loadSetting(PENDING_AUTOHATCH_KEY, false, v => typeof v === 'boolean')) return
    if (document.getElementById('auto-hatch-start')) {
      restoreAutoHatch()
      return
    }
    if (attempts >= 5) {
      log(LOG.WARN, 'Auto Hatch was suspended by QuestAssistant but the script is no longer loaded; clearing the pending restore')
      clearSetting(PENDING_AUTOHATCH_KEY)
      return
    }
    setTimeout(() => tryRestoreAutohatch(attempts + 1), 1000)
  }
  function restoreAutoHatch () {
    if (!loadSetting(PENDING_AUTOHATCH_KEY, false, v => typeof v === 'boolean')) return false
    if (typeof toggleAutoHatch !== 'function') {
      log(LOG.WARN, 'Enhanced Auto Hatchery not loaded; cannot restore Auto Hatch')
      return false
    }
    if (!hatchState) toggleAutoHatch({ target: document.getElementById('auto-hatch-start') })
    clearSetting(PENDING_AUTOHATCH_KEY)
    log(LOG.INFO, 'Re-enabled Enhanced Auto Hatchery')
    return true
  }
  // catch mode helpers
  
  // #endregion CapturePokemonTypes helpers
  
  const captureTypesQuestHandler = quest => {
    const typeStr = PokemonType[quest.type]
    if (!typeStr) decline(`index ${quest.type} not found in PokemonType`)
    const remaining = () => quest.amount - (quest.focus() - quest.initial())
    const ctx = { quest, typeStr, remaining }

    const modes = {
      catch: catchMode(ctx),
      filter: hatchFilterMode(ctx),
      queue: hatchQueueMode(ctx)
    }
    const activeKey = ko.pureComputed(() => {
      const strategy = CAPTURE_TYPE_STRATEGY()
      const hatch = HATCH_ACTION_MODE()
      if (strategy === 'catch') return 'catch'
      if (strategy === 'both') return `catch+${hatch}`
      return hatch
    })
    const activeModes = () => activeKey().split('+').map(k => modes[k])

    let current = activeKey().split('+')
    const modeSub = activeKey.subscribe(next => {
      const nextKeys = next.split('+')
      current.filter(k => !nextKeys.includes(k)).forEach(k => {
        log(LOG.INFO, `Releasing ${k} mode`)
        modes[k].release()
      })
      current = nextKeys
    })

    const STATE_PRECEDENCE = [STATE.READY, STATE.PENDING, STATE.APPLIED, STATE.SATISFIED, STATE.UNAVAILABLE]

    const combined = () => {
      const parts = activeModes().map(m => [m, m.assess()])
      const state = STATE_PRECEDENCE.find(s => parts.some(([, a]) => a.state === s)) ?? STATE.UNAVAILABLE
      return { parts, state }
    }

    return {
      state: () => combined().state,
      tooltip: () => {
        const { parts } = combined()
        if (parts.length === 1) return parts[0][1].tip
        return parts.map(([m, a]) => `<b>${m.label}:</b> ${a.tip}`).join('<br>')
      },
      click: () => {
        const { parts, state } = combined()
        parts.filter(([, a]) => a.state === state).forEach(([m]) => m.click(state))
      },
      onEnd: () => {
        Object.values(modes).forEach(m => { m.release(); m.dispose() })
        modeSub.dispose()
      }
    }
  }
  // #endregion CapturePokemonTypes Quest Handler
  // #endregion Quest Handlers

  // #region Orchestrators
  // Map quest types to handlers
  const QUEST_HANDLERS = [
    { types: ['DefeatPokemonsQuest'], handler: routeQuestHandler },
    { types: ['DefeatDungeonQuest', 'DefeatDungeonBossQuest'], handler: dungeonQuestHandler },
    { types: ['DefeatGymQuest'], handler: gymQuestHandler },
    { types: ['ClearBattleFrontierQuest'], handler: frontierQuestHandler },
    { types: ['CatchShadowsQuest'], handler: shadowQuestHandler },
    { types: ['UsePokeballQuest'], handler: usePokeballQuestHandler },
    { types: ['GainGemsQuest'], handler: gemQuestHandler },
    { types: ['UseOakItemQuest'], handler: oakItemQuestHandler },
    { types: ['CapturePokemonTypesQuest'], handler: captureTypesQuestHandler }
  ]
  const HANDLERS_BY_TYPE = new Map(
    QUEST_HANDLERS.flatMap(({ types, handler }) => types.map(type => [type, handler]))
  )
  // danger! reflection ahead! will break if this is minified!
  const questType = quest => quest.constructor.name

  function questAction (quest) {
    if (specs.has(quest)) return specs.get(quest)
    
    const type = questType(quest)
    const handler = HANDLERS_BY_TYPE.get(type)
    if (!handler) {
      log(LOG.WARN, `No handler implemented for ${type}`)
      return null
    }

    let raw
    try {
      raw = handler(quest)
    } catch (e) {
      if (e instanceof HandlerDeclined) {
        log(LOG.INFO, `${type} handler declined: ${e.message}`)
        return null
      }
      log(LOG.ERROR, `${type} handler threw: ${e.message}`)
      return null
    }
    const state = raw.state ?? (() => raw.ready?.() === false ? STATE.UNAVAILABLE : STATE.READY)
    const spec = { ...raw, state }

    specs.set(quest, spec)
    return spec
  }
  // #endregion Orchestrators

  // #region Debug Helpers
  const LOG = {
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4
  }
  const LOG_LEVEL = ko.observable(0) // reassigned during init
  function log (level, ...args) {
    if (level <= LOG_LEVEL()) {
      const color = level === LOG.ERROR
        ? 'color: red'
        : level === LOG.WARN
          ? 'color: orange'
          : level === LOG.INFO
            ? 'color: blue'
            : 'color: gray'
      console.log(`%c[${SCRIPT_NAME}] [${Object.keys(LOG).find(key => LOG[key] === level)}]`, color, ...args)
    }
  }
  const scriptWindow = !App.isUsingClient ? unsafeWindow : window
  scriptWindow.QuestAssistant = {
    decorateAll,
    questAction,
    handlers: HANDLERS_BY_TYPE,
    rows: questRows,
    init: initQuestAssistant,
    log,
    loadSettings,
    loadSetting,
    saveSetting,
    clearSetting,
    questPls, // dangerous debug helper
    questBegone, // dangerous debug helper
    restoreHatcheryFilters,
    // route auditing
    explainRoutes,
    explainRanking,
    rankRoutes,
    rankRoutesByType,
    AREA_WEIGHTS,
    PRIORITY_MODES
  }
  function reindexQuests () {
    App.game.quests.questList().forEach((q, i) => { q.index = i })
  }
  function questPls (type) {
    const quests = App.game.quests
    if (!HANDLERS_BY_TYPE.has(type)) {
      log(LOG.WARN, `No handler for '${type}'. Known:`, [...HANDLERS_BY_TYPE.keys()])
    }

    let quest
    try {
      quest = QuestHelper.createQuest(type)
    } catch (e) {
      log(LOG.ERROR, `createQuest('${type}') threw:`, e)
      return null
    }
    if (!quest) {
      log(LOG.ERROR, `createQuest('${type}') returned nothing`)
      return null
    }

    quest.index = quests.questList().length
    quest.begin()
    quests.questList.push(quest)
    log(LOG.WARN, `Added synthetic ${type} at index ${quest.index}: this persists in your save`, quest)
    return quest
  }

  function questBegone (target, giveBonus = false) {
    const quests = App.game.quests
    const quest = typeof target === 'number' ? quests.questList()[target] : target
    if (!quest || !quests.questList().includes(quest)) {
      log(LOG.ERROR, 'No such quest in questList:', target)
      return false
    }

    endQuest(quest, 'removed') // unwind handler state before the row disappears
    tracked.delete(quest)
    specs.delete(quest)
    quests.questList.remove(quest)
    reindexQuests()
    log(LOG.WARN, 'Removed quest', quest)

    if (quests.allQuestClaimed()) {
      // Adapted from Quests.claimQuest (src/scripts/quests/Quests.ts)
      if (giveBonus) {
        const bonus = quests.calcListBonus()
        App.game.wallet.gainQuestPoints(bonus)
        Notifier.notify({
          message: `All quests completed. Your quest list has been refreshed and you gained an extra <img src="./assets/images/currency/questPoint.svg" height="24px"/> ${bonus.toLocaleString('en-US')}.`,
          type: NotificationConstants.NotificationOption.info,
          timeout: 1e4,
          setting: NotificationConstants.NotificationSetting.General.quest_completed
        })
      }
      quests.refreshQuests(true)
      quests.freeRefresh(true)
    }
    return true
  }
  // #endregion Debug Helpers

  // #region Settings UI
  function addSettingRow (body, { id, label, tooltip, type, options, observable, key, parse = v => v }) {
    const control = {
      select: () => `<select id="${id}" class="form-control">
        ${options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
      </select>`,
      checkbox: () => `<input type="checkbox" id="${id}">`,
      number: () => `<input type="number" id="${id}" class="form-control" min="0">`
    }[type]()
    const labelAttrs = tooltip
        ? ` data-toggle="tooltip" data-placement="top" title="${tooltip.replace(/"/g, '&quot;')}"`
        : ''
    const row = document.createElement('tr')
    row.innerHTML = `<td class="p-2 col-md-8"${labelAttrs}><label class="m-0" for="${id}">${label}</label></td>
      <td class="p-2 col-md-4">${control}</td>`
    body.appendChild(row)
    if (tooltip) $(row.querySelector('td')).tooltip()

    const input = row.querySelector(`#${id}`)
    if (type === 'checkbox') input.checked = observable()
    else input.value = observable()

    input.addEventListener('change', event => {
      const val = type === 'checkbox' ? event.target.checked : parse(event.target.value)
      observable(val)
      saveSetting(key, val)
    })
    return input
  }
  
  function initSettings () {
    const settingsBody = createScriptSettingsContainer('Quest Assistant')

    addSettingRow(settingsBody, {
      id: 'checkbox-qaAutoclicker',
      label: 'Enhanced Auto Clicker integration',
      tooltip: 'When traveling for a quest, also start the matching Enhanced Auto Clicker mode. Lets quest buttons request a soft dungeon exit instead of being blocked.',
      type: 'checkbox',
      observable: AUTOCLICKER_ENABLED,
      parse: value => !!value,
      key: AUTOCLICKER_KEY
    })

    addSettingRow(settingsBody, {
      id: 'checkbox-qaAutohatch',
      label: 'Enhanced Auto Hatchery integration',
      tooltip: 'Automatically override and restore the Enhanced Auto Hatchery state when it would interfere with quest actions.',
      type: 'checkbox',
      observable: AUTOHATCH_ENABLED,
      parse: value => !!value,
      key: AUTOHATCH_KEY
    })

    addSettingRow(settingsBody, {
      id: 'select-qaCaptureTypeStrategy',
      label: 'Capture Type Strategy',
      tooltip: 'How to approach type capture quests. Hatch uses the hatchery; catch works through encounters. Both uses the hatchery and encounters in parallel, since they progress the same quest independently.',
      type: 'select',
      options: [
        ['hatch', 'Hatch'],
        ['catch', 'Catch'],
        ['both', 'Both'],
      ],
      observable: CAPTURE_TYPE_STRATEGY,
      key: CAPTURE_TYPE_STRATEGY_KEY
    })

    addSettingRow(settingsBody, {
      id: 'select-qaHatchActionMode',
      label: 'Hatch Action Mode',
      tooltip: 'What the button does when hatching. Filter sets the hatchery type filter (pairs well with hatchery helpers and Enhanced Auto Hatchery). Queue adds matching Pokémon to the hatchery queue continuously.',
      type: 'select',
      options: [
        ['filter', 'Filter'],
        ['queue', 'Queue']
      ],
      observable: HATCH_ACTION_MODE,
      key: HATCH_ACTION_MODE_KEY
    })

    addSettingRow(settingsBody, {
      id: 'select-qaFilterRelaxThreshold',
      label: 'Filter Relax Threshold',
      tooltip: 'In hatch filter mode, if fewer than this many Pokémon match after filtering by type, temporarily clear your other hatchery filters as well. Set to 0 to leave other filters alone.',
      type: 'number',
      observable: FILTER_RELAX_THRESHOLD,
      parse: Number,
      key: FILTER_RELAX_THRESHOLD_KEY
    })

    addSettingRow(settingsBody, {
      id: 'input-qaQueueDepth',
      label: 'Hatchery queue depth',
      tooltip: 'In hatch queue mode, how many matching Pokémon to keep queued at once. Queued Pokémon stop contributing to your damage, so keep this low and let the watcher top it up as eggs hatch. Setting to 0 will only queue when a hatchery slot is empty or ready to hatch.',
      type: 'number',
      observable: QUEUE_DEPTH,
      parse: Number,
      key: QUEUE_DEPTH_KEY
    })

    addSettingRow(settingsBody, {
      id: 'select-qaLogLevel',
      label: 'Log level',
      tooltip: 'How much this script writes to the browser console. Debug is useful when reporting a problem.',
      type: 'select',
      options: [['0', 'Off'], ['1', 'Error'], ['2', 'Warn'], ['3', 'Info'], ['4', 'Debug']],
      parse: Number,
      observable: LOG_LEVEL,
      key: LOG_LEVEL_KEY
    })

    addSettingRow(settingsBody, {
      id: 'select-qaCatchRoutePriority',
      label: 'Catch route priority',
      tooltip: 'How much to favor routes with rewards left to earn (uncaught, shiny, achievement, resistant) over raw catch speed. Fastest ignores them entirely.',
      type: 'select',
      options: [['fastest', 'Fastest'], ['balanced', 'Balanced'], ['completion', 'Completion first']],
      parse: String,
      observable: CATCH_ROUTE_PRIORITY,
      key: CATCH_ROUTE_PRIORITY_KEY
    })

    addSettingRow(settingsBody, {
      id: 'input-qaHealthOffset',
      label: 'Route health offset',
      tooltip: 'Every encounter costs some fixed time regardless of how weak the target is, so very low-health routes are not proportionally faster. Expressed as a multiple of your Pokémon attack. 0 ranks purely by health. Around 0.35 suits an endgame save with an autoclicker.',
      type: 'number',
      parse: Number,
      observable: HEALTH_OFFSET,
      key: HEALTH_OFFSET_KEY
    })    
  }
  // #endregion Settings UI

  // #region Save/load

  function loadSetting (key, defaultVal, allowed) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key)
      if (raw === null) return defaultVal
      const val = JSON.parse(raw)
      if (val === null || typeof val !== typeof defaultVal) return defaultVal
      if (typeof val === 'object' && val.constructor.name !== defaultVal.constructor.name) return defaultVal
      if (Array.isArray(allowed) && !allowed.includes(val)) return defaultVal
      if (typeof allowed === 'function' && !allowed(val)) return defaultVal
      return val
    } catch (e) {
      log(LOG.WARN, `Failed to load setting ${key}:`, e)
      return defaultVal
    }
  }

  function saveSetting (key, val) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(val))
      log(LOG.INFO, `Setting ${key} saved with value:`, val)
    } catch (e) {
      log(LOG.WARN, `Failed to save setting ${key}:`, e)
    }
  }

  function clearSetting (key) {
    localStorage.removeItem(STORAGE_PREFIX + key)
  }
  // #endregion Save/load
  
  // #region Ephenia boilerplate

  /**
   * Creates container for scripts settings in the settings menu, adding scripts tab if it doesn't exist yet
   */
  function createScriptSettingsContainer(name) {
      const settingsID = name.replaceAll(/\s/g, '').toLowerCase();
      var settingsContainer = document.getElementById('settings-scripts-container');

      // Create scripts settings tab if it doesn't exist yet
      if (!settingsContainer) {
          // Fixes the Scripts nav item getting wrapped to the bottom by increasing the max width of the window
          document.querySelector('#settingsModal div').style.maxWidth = '850px';
          // Create and attach script settings tab link
          const settingTabs = document.querySelector('#settingsModal ul.nav-tabs');
          const li = document.createElement('li');
          li.classList.add('nav-item');
          li.innerHTML = `<a class="nav-link" href="#settings-scripts" data-toggle="tab">Scripts</a>`;
          settingTabs.appendChild(li);
          // Create and attach script settings tab contents
          const tabContent = document.querySelector('#settingsModal .tab-content');
          scriptSettings = document.createElement('div');
          scriptSettings.classList.add('tab-pane');
          scriptSettings.setAttribute('id', 'settings-scripts');
          tabContent.appendChild(scriptSettings);
          settingsContainer = document.createElement('div');
          settingsContainer.setAttribute('id', 'settings-scripts-container');
          scriptSettings.appendChild(settingsContainer);
      }

      // Create settings container
      const settingsTable = document.createElement('table');
      settingsTable.classList.add('table', 'table-striped', 'table-hover', 'm-0');
      const header = document.createElement('thead');
      header.innerHTML = `<tr><th colspan="2">${name}</th></tr>`;
      settingsTable.appendChild(header);
      const settingsBody = document.createElement('tbody');
      settingsBody.setAttribute('id', `settings-scripts-${settingsID}`);
      settingsTable.appendChild(settingsBody);

      // Insert settings container in alphabetical order
      let settingsList = Array.from(settingsContainer.children);
      let insertBefore = settingsList.find(elem => elem.querySelector('tbody').id > `settings-scripts-${settingsID}`);
      if (insertBefore) {
          insertBefore.before(settingsTable);
      } else {
          settingsContainer.appendChild(settingsTable);
      }

      return settingsBody;
  }

  function loadEpheniaScript (scriptName, initFunction, priorityFunction) {
    function reportScriptError (scriptName, error) {
      console.error(`Error while initializing '${scriptName}' userscript:\n${error}`)
      Notifier.notify({
        type: NotificationConstants.NotificationOption.warning,
        title: scriptName,
        message: `The '${scriptName}' userscript crashed while loading. Check for updates or disable the script, then restart the game.\n\nReport script issues to the script developer, not to the Pokéclicker team.`,
        timeout: GameConstants.DAY
      })
    }
    const windowObject = !App.isUsingClient ? unsafeWindow : window
    // Inject handlers if they don't exist yet
    if (windowObject.epheniaScriptInitializers === undefined) {
      windowObject.epheniaScriptInitializers = {}
      const oldInit = Preload.hideSplashScreen
      let hasInitialized = false

      // Initializes scripts once enough of the game has loaded
      Preload.hideSplashScreen = function (...args) {
        const result = oldInit.apply(this, args)
        if (App.game && !hasInitialized) {
          // Initialize all attached userscripts
          Object.entries(windowObject.epheniaScriptInitializers).forEach(([scriptName, initFunction]) => {
            try {
              initFunction()
            } catch (e) {
              reportScriptError(scriptName, e)
            }
          })
          hasInitialized = true
        }
        return result
      }
    }

    // Prevent issues with duplicate script names
    if (windowObject.epheniaScriptInitializers[scriptName] !== undefined) {
      console.warn(`Duplicate '${scriptName}' userscripts found!`)
      Notifier.notify({
        type: NotificationConstants.NotificationOption.warning,
        title: scriptName,
        message: `Duplicate '${scriptName}' userscripts detected. This could cause unpredictable behavior and is not recommended.`,
        timeout: GameConstants.DAY
      })
      let number = 2
      while (windowObject.epheniaScriptInitializers[`${scriptName} ${number}`] !== undefined) {
        number++
      }
      scriptName = `${scriptName} ${number}`
    }
    // Add initializer for this particular script
    windowObject.epheniaScriptInitializers[scriptName] = initFunction
    // Run any functions that need to execute before the game starts
    if (priorityFunction) {
      $(document).ready(() => {
        try {
          priorityFunction()
        } catch (e) {
          reportScriptError(scriptName, e)
          // Remove main initialization function
          windowObject.epheniaScriptInitializers[scriptName] = () => null
        }
      })
    }
  }
  if (!App.isUsingClient || localStorage.getItem(SCRIPT_NAME) === 'true') {
    loadEpheniaScript(SCRIPT_NAME, initQuestAssistant)
  }
  // #endregion Ephenia boilerplate
}
QuestAssistant()
