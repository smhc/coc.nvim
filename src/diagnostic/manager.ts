import { Neovim } from '@chemzqm/neovim'
import { Diagnostic, DiagnosticSeverity, Disposable, Location, Range, TextDocument, Position } from 'vscode-languageserver-protocol'
import { URI } from 'vscode-uri'
import events from '../events'
import Document from '../model/document'
import FloatFactory from '../model/floatFactory'
import { ConfigurationChangeEvent, DiagnosticItem, Documentation } from '../types'
import { disposeAll, wait } from '../util'
import { comparePosition, positionInRange, lineInRange, rangeIntersect } from '../util/position'
import workspace from '../workspace'
import { DiagnosticBuffer } from './buffer'
import DiagnosticCollection from './collection'
import { getSeverityName, getSeverityType, severityLevel } from './util'
const logger = require('../util/logger')('diagnostic-manager')

export interface DiagnosticConfig {
  enableSign: boolean
  checkCurrentLine: boolean
  enableMessage: string
  virtualText: boolean
  displayByAle: boolean
  srcId: number
  locationlist: boolean
  signOffset: number
  errorSign: string
  warningSign: string
  infoSign: string
  hintSign: string
  level: number
  messageTarget: string
  joinMessageLines: boolean
  maxWindowHeight: number
  refreshAfterSave: boolean
  refreshOnInsertMode: boolean
  virtualTextSrcId: number
  virtualTextPrefix: string
  virtualTextLines: number
  virtualTextLineSeparator: string
}

export class DiagnosticManager implements Disposable {
  public config: DiagnosticConfig
  public enabled = true
  public readonly buffers: DiagnosticBuffer[] = []
  private floatFactory: FloatFactory
  private collections: DiagnosticCollection[] = []
  private disposables: Disposable[] = []
  private lastMessage = ''
  private timer: NodeJS.Timer

  public init(): void {
    this.setConfiguration()
    let { nvim } = workspace
    let { maxWindowHeight } = this.config
    this.floatFactory = new FloatFactory(nvim, workspace.env, false, maxWindowHeight)
    this.disposables.push(Disposable.create(() => {
      if (this.timer) clearTimeout(this.timer)
    }))
    let moved = false
    events.on('CursorMoved', async () => {
      moved = true
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(async () => {
        if (this.config.enableMessage != 'always') return
        if (this.config.messageTarget == 'float') return
        await this.echoMessage(true)
      }, 500)
    }, null, this.disposables)
    if (this.config.messageTarget == 'float') {
      this.disposables.push(workspace.registerAutocmd({
        event: 'CursorHold',
        request: true,
        callback: async () => {
          if (!moved) return
          moved = false
          let popup = await nvim.eval('get(w:, "float", 0)')
          if (popup) return
          await this.echoMessage(true)
        }
      }))
    }
    events.on('InsertEnter', async () => {
      this.floatFactory.close()
      if (this.timer) clearTimeout(this.timer)
    }, null, this.disposables)

    events.on('InsertLeave', async bufnr => {
      this.floatFactory.close()
      let doc = workspace.getDocument(bufnr)
      if (!doc || !this.shouldValidate(doc)) return
      let { refreshOnInsertMode, refreshAfterSave } = this.config
      if (!refreshOnInsertMode && !refreshAfterSave) {
        await wait(500)
        this.refreshBuffer(doc.uri)
      }
    }, null, this.disposables)

    events.on('BufEnter', async bufnr => {
      if (this.timer) clearTimeout(this.timer)
      if (!this.config || !this.enabled || !this.config.locationlist) return
      let doc = workspace.getDocument(bufnr)
      if (!this.shouldValidate(doc) || doc.bufnr != bufnr) return
      let refreshed = this.refreshBuffer(doc.uri)
      if (!refreshed) {
        let winid = await nvim.call('win_getid') as number
        let curr = await nvim.call('getloclist', [winid, { title: 1 }])
        if ((curr.title && curr.title.indexOf('Diagnostics of coc') != -1)) {
          nvim.call('setloclist', [winid, [], 'f'], true)
        }
      }
    }, null, this.disposables)

    events.on('BufWritePost', async bufnr => {
      let buf = this.buffers.find(buf => buf.bufnr == bufnr)
      if (buf) await buf.checkSigns()
      await wait(100)
      if (this.config.refreshAfterSave) {
        this.refreshBuffer(buf.uri)
      }
    }, null, this.disposables)

    workspace.onDidChangeConfiguration(async e => {
      this.setConfiguration(e)
    }, null, this.disposables)

    // create buffers
    for (let doc of workspace.documents) {
      this.createDiagnosticBuffer(doc)
    }
    workspace.onDidOpenTextDocument(textDocument => {
      let doc = workspace.getDocument(textDocument.uri)
      this.createDiagnosticBuffer(doc)
    }, null, this.disposables)
    workspace.onDidCloseTextDocument(async ({ uri }) => {
      let doc = workspace.getDocument(uri)
      if (!doc) return
      let { bufnr } = doc
      let idx = this.buffers.findIndex(buf => buf.bufnr == bufnr)
      if (idx == -1) return
      let buf = this.buffers[idx]
      buf.dispose()
      this.buffers.splice(idx, 1)
      for (let collection of this.collections) {
        collection.delete(buf.uri)
      }
      await buf.clear()
    }, null, this.disposables)
    this.setConfigurationErrors(true)
    workspace.configurations.onError(async () => {
      this.setConfigurationErrors()
    }, null, this.disposables)
    let { errorSign, warningSign, infoSign, hintSign } = this.config
    nvim.pauseNotification()
    nvim.command(`sign define CocError   text=${errorSign}   linehl=CocErrorLine texthl=CocErrorSign`, true)
    nvim.command(`sign define CocWarning text=${warningSign} linehl=CocWarningLine texthl=CocWarningSign`, true)
    nvim.command(`sign define CocInfo    text=${infoSign}    linehl=CocInfoLine  texthl=CocInfoSign`, true)
    nvim.command(`sign define CocHint    text=${hintSign}    linehl=CocHintLine  texthl=CocHintSign`, true)
    if (this.config.virtualText && workspace.isNvim) {
      nvim.call('coc#util#init_virtual_hl', [], true)
    }
    nvim.resumeNotification(false, true).catch(_e => {
      // noop
    })
  }

  private createDiagnosticBuffer(doc: Document): void {
    if (!this.shouldValidate(doc)) return
    let idx = this.buffers.findIndex(b => b.bufnr == doc.bufnr)
    if (idx == -1) {
      let buf = new DiagnosticBuffer(doc, this.config)
      this.buffers.push(buf)
      buf.onDidRefresh(() => {
        if (workspace.insertMode) return
        this.echoMessage(true).catch(_e => {
          // noop
        })
      })
    }
  }

  public setConfigurationErrors(init?: boolean): void {
    let collections = this.collections
    let collection = collections.find(o => o.name == 'config')
    if (!collection) {
      collection = this.create('config')
    } else {
      collection.clear()
    }
    let { errorItems } = workspace.configurations
    if (errorItems && errorItems.length) {
      if (init) workspace.showMessage(`settings file parse error, run ':CocList diagnostics'`, 'error')
      let entries: Map<string, Diagnostic[]> = new Map()
      for (let item of errorItems) {
        let { uri } = item.location
        let diagnostics: Diagnostic[] = entries.get(uri) || []
        diagnostics.push(Diagnostic.create(item.location.range, item.message, DiagnosticSeverity.Error))
        entries.set(uri, diagnostics)
      }
      collection.set(Array.from(entries))
    }
  }

  /**
   * Create collection by name
   */
  public create(name: string): DiagnosticCollection {
    let collection = new DiagnosticCollection(name)
    this.collections.push(collection)
    let disposable = collection.onDidDiagnosticsChange(async uri => {
      if (this.config.refreshAfterSave) return
      this.refreshBuffer(uri)
    })
    let dispose = collection.onDidDiagnosticsClear(uris => {
      for (let uri of uris) {
        this.refreshBuffer(uri)
      }
    })
    collection.onDispose(() => {
      disposable.dispose()
      dispose.dispose()
      let idx = this.collections.findIndex(o => o == collection)
      if (idx !== -1) this.collections.splice(idx, 1)
      collection.forEach((uri, diagnostics) => {
        if (diagnostics && diagnostics.length) this.refreshBuffer(uri)
      })
    })
    return collection
  }

  /**
   * Get diagnostics ranges from document
   */
  public getSortedRanges(uri: string, severity?: string): Range[] {
    let collections = this.getCollections(uri)
    let res: Range[] = []
    let level = severity ? severityLevel(severity) : 0
    for (let collection of collections) {
      let diagnostics = collection.get(uri)
      if (level) diagnostics = diagnostics.filter(o => o.severity == level)
      let ranges = diagnostics.map(o => o.range)
      res.push(...ranges)
    }
    res.sort((a, b) => {
      if (a.start.line != b.start.line) {
        return a.start.line - b.start.line
      }
      return a.start.character - b.start.character
    })
    return res
  }

  /**
   * Get readonly diagnostics for a buffer
   */
  public getDiagnostics(uri: string): ReadonlyArray<Diagnostic> {
    let collections = this.getCollections(uri)
    let { level } = this.config
    let res: Diagnostic[] = []
    for (let collection of collections) {
      let items = collection.get(uri)
      if (!items) continue
      if (level && level < DiagnosticSeverity.Hint) {
        items = items.filter(s => s.severity == null || s.severity <= level)
      }
      res.push(...items)
    }
    res.sort((a, b) => {
      if (a.severity == b.severity) {
        let d = comparePosition(a.range.start, b.range.start)
        if (d != 0) return d
        if (a.source == b.source) return a.message > b.message ? 1 : -1
        return a.source > b.source ? 1 : -1
      }
      return a.severity - b.severity
    })
    return res
  }

  public getDiagnosticsInRange(document: TextDocument, range: Range): Diagnostic[] {
    let collections = this.getCollections(document.uri)
    let res: Diagnostic[] = []
    for (let collection of collections) {
      let items = collection.get(document.uri)
      if (!items) continue
      for (let item of items) {
        if (rangeIntersect(item.range, range)) {
          res.push(item)
        }
      }
    }
    return res
  }

  /**
   * Jump to previouse diagnostic position
   */
  public async jumpPrevious(severity?: string): Promise<void> {
    let buffer = await this.nvim.buffer
    let document = workspace.getDocument(buffer.id)
    if (!document) return
    let offset = await workspace.getOffset()
    if (offset == null) return
    let ranges = this.getSortedRanges(document.uri, severity)
    if (ranges.length == 0) {
      workspace.showMessage('Empty diagnostics', 'warning')
      return
    }
    let { textDocument } = document
    for (let i = ranges.length - 1; i >= 0; i--) {
      if (textDocument.offsetAt(ranges[i].end) < offset) {
        await this.jumpTo(ranges[i])
        return
      }
    }
    await this.jumpTo(ranges[ranges.length - 1])
  }

  /**
   * Jump to next diagnostic position
   */
  public async jumpNext(severity?: string): Promise<void> {
    let buffer = await this.nvim.buffer
    let document = workspace.getDocument(buffer.id)
    let offset = await workspace.getOffset()
    let ranges = this.getSortedRanges(document.uri, severity)
    if (ranges.length == 0) {
      workspace.showMessage('Empty diagnostics', 'warning')
      return
    }
    let { textDocument } = document
    for (let i = 0; i <= ranges.length - 1; i++) {
      if (textDocument.offsetAt(ranges[i].start) > offset) {
        await this.jumpTo(ranges[i])
        return
      }
    }
    await this.jumpTo(ranges[0])
  }

  /**
   * All diagnostics of current workspace
   */
  public getDiagnosticList(): DiagnosticItem[] {
    let res: DiagnosticItem[] = []
    for (let collection of this.collections) {
      collection.forEach((uri, diagnostics) => {
        let file = URI.parse(uri).fsPath
        for (let diagnostic of diagnostics) {
          let { start } = diagnostic.range
          let o: DiagnosticItem = {
            file,
            lnum: start.line + 1,
            col: start.character + 1,
            message: `[${diagnostic.source || collection.name}${diagnostic.code ? ' ' + diagnostic.code : ''}] ${diagnostic.message}`,
            severity: getSeverityName(diagnostic.severity),
            level: diagnostic.severity || 0,
            location: Location.create(uri, diagnostic.range)
          }
          res.push(o)
        }
      })
    }
    res.sort((a, b) => {
      if (a.level !== b.level) {
        return a.level - b.level
      }
      if (a.file !== b.file) {
        return a.file > b.file ? 1 : -1
      } else {
        if (a.lnum != b.lnum) {
          return a.lnum - b.lnum
        }
        return a.col - b.col
      }
    })
    return res
  }

  public async getCurrentDiagnostics(): Promise<Diagnostic[]> {
    let [bufnr, cursor] = await this.nvim.eval('[bufnr("%"),coc#util#cursor()]') as [number, [number, number]]
    let pos = Position.create(cursor[0], cursor[1])
    let buffer = this.buffers.find(o => o.bufnr == bufnr)
    if (!buffer) return []
    let { checkCurrentLine } = this.config
    let diagnostics = buffer.diagnostics.filter(o => {
      if (checkCurrentLine) return lineInRange(pos.line, o.range)
      return positionInRange(pos, o.range) == 0
    })
    return diagnostics
  }

  /**
   * Echo diagnostic message of currrent position
   */
  public async echoMessage(truncate = false): Promise<void> {
    if (!this.enabled || this.config.enableMessage == 'never') return
    if (this.timer) clearTimeout(this.timer)
    let useFloat = this.config.messageTarget == 'float'
    let diagnostics = await this.getCurrentDiagnostics()
    if (diagnostics.length == 0) {
      if (useFloat) {
        this.floatFactory.close()
      } else {
        let echoLine = await this.nvim.call('coc#util#echo_line') as string
        if (this.lastMessage && this.lastMessage == echoLine.trim()) {
          this.nvim.command('echo ""', true)
        }
        this.lastMessage = ''
      }
      return
    }
    if (truncate && workspace.insertMode) return
    let lines: string[] = []
    let docs: Documentation[] = []
    diagnostics.forEach(diagnostic => {
      let { source, code, severity, message } = diagnostic
      let s = getSeverityName(severity)[0]
      let str = `[${source}${code ? ' ' + code : ''}] [${s}] ${message}`
      let filetype = 'Error'
      switch (diagnostic.severity) {
        case DiagnosticSeverity.Hint:
          filetype = 'Hint'
          break
        case DiagnosticSeverity.Warning:
          filetype = 'Warning'
          break
        case DiagnosticSeverity.Information:
          filetype = 'Info'
          break
      }
      docs.push({ filetype, content: str })
      lines.push(...str.split('\n'))
    })
    if (useFloat) {
      await this.floatFactory.create(docs)
    } else {
      this.lastMessage = lines[0]
      await this.nvim.command('echo ""')
      await workspace.echoLines(lines, truncate)
    }
  }

  public async jumpRelated(): Promise<void> {
    let diagnostics = await this.getCurrentDiagnostics()
    if (!diagnostics) return
    let diagnostic = diagnostics.find(o => o.relatedInformation != null)
    if (!diagnostic) return
    let locations = diagnostic.relatedInformation.map(o => o.location)
    if (locations.length == 1) {
      await workspace.jumpTo(locations[0].uri, locations[0].range.start)
    } else if (locations.length > 1) {
      await workspace.showLocations(locations)
    }
  }

  public hideFloat(): void {
    if (this.floatFactory) {
      this.floatFactory.close()
    }
  }

  public dispose(): void {
    for (let collection of this.collections) {
      collection.dispose()
    }
    if (this.floatFactory) {
      this.floatFactory.dispose()
    }
    this.buffers.splice(0, this.buffers.length)
    this.collections = []
    disposeAll(this.disposables)
  }

  private get nvim(): Neovim {
    return workspace.nvim
  }

  private setConfiguration(event?: ConfigurationChangeEvent): void {
    if (event && !event.affectsConfiguration('diagnostic')) return
    let preferences = workspace.getConfiguration('coc.preferences.diagnostic')
    let config = workspace.getConfiguration('diagnostic')
    function getConfig<T>(key: string, defaultValue: T): T {
      return preferences.get<T>(key, config.get<T>(key, defaultValue))
    }
    let messageTarget = getConfig<string>('messageTarget', 'float')
    if (messageTarget == 'float' && !workspace.env.floating && !workspace.env.textprop) {
      messageTarget = 'echo'
    }
    this.config = {
      messageTarget,
      srcId: workspace.createNameSpace('coc-diagnostic') || 1000,
      virtualTextSrcId: workspace.createNameSpace('diagnostic-virtualText'),
      checkCurrentLine: getConfig<boolean>('checkCurrentLine', false),
      enableSign: getConfig<boolean>('enableSign', true),
      maxWindowHeight: getConfig<number>('maxWindowHeight', 10),
      enableMessage: getConfig<string>('enableMessage', 'always'),
      joinMessageLines: getConfig<boolean>('joinMessageLines', false),
      virtualText: getConfig<boolean>('virtualText', false),
      virtualTextPrefix: getConfig<string>('virtualTextPrefix', " "),
      virtualTextLineSeparator: getConfig<string>('virtualTextLineSeparator', " \\ "),
      virtualTextLines: getConfig<number>('virtualTextLines', 3),
      displayByAle: getConfig<boolean>('displayByAle', false),
      level: severityLevel(getConfig<string>('level', 'hint')),
      locationlist: getConfig<boolean>('locationlist', true),
      signOffset: getConfig<number>('signOffset', 1000),
      errorSign: getConfig<string>('errorSign', '>>'),
      warningSign: getConfig<string>('warningSign', '>>'),
      infoSign: getConfig<string>('infoSign', '>>'),
      hintSign: getConfig<string>('hintSign', '>>'),
      refreshAfterSave: getConfig<boolean>('refreshAfterSave', false),
      refreshOnInsertMode: getConfig<boolean>('refreshOnInsertMode', false),
    }
    this.enabled = getConfig<boolean>('enable', true)
    if (this.config.displayByAle) {
      this.enabled = false
    }
    if (event) {
      for (let severity of ['error', 'info', 'warning', 'hint']) {
        let key = `diagnostic.${severity}Sign`
        if (event.affectsConfiguration(key)) {
          let text = config.get<string>(`${severity}Sign`, '>>')
          let name = severity[0].toUpperCase() + severity.slice(1)
          this.nvim.command(`sign define Coc${name}   text=${text}   linehl=Coc${name}Line texthl=Coc${name}Sign`, true)
        }
      }
    }
  }

  private getCollections(uri: string): DiagnosticCollection[] {
    return this.collections.filter(c => c.has(uri))
  }

  private shouldValidate(doc: Document | null): boolean {
    return doc != null && doc.buftype == ''
  }

  private refreshBuffer(uri: string): boolean {
    // vim has issue with diagnostic update
    if (workspace.insertMode && !this.config.refreshOnInsertMode) return
    let buf = this.buffers.find(buf => buf.uri == uri)
    let { displayByAle } = this.config
    if (buf) {
      if (displayByAle) {
        let { nvim } = this
        let allDiagnostics: Map<string, any[]> = new Map()
        for (let collection of this.collections) {
          let diagnostics = collection.get(uri)
          let aleItems = diagnostics.map(o => {
            let { range } = o
            return {
              text: o.message,
              code: o.code,
              lnum: range.start.line + 1,
              col: range.start.character + 1,
              end_lnum: range.end.line + 1,
              end_col: range.end.character,
              type: getSeverityType(o.severity)
            }
          })
          let exists = allDiagnostics.get(collection.name)
          if (exists) {
            exists.push(...aleItems)
          } else {
            allDiagnostics.set(collection.name, aleItems)
          }
        }
        nvim.pauseNotification()
        for (let key of allDiagnostics.keys()) {
          this.nvim.call('ale#other_source#ShowResults', [buf.bufnr, key, allDiagnostics.get(key)], true)
        }
        nvim.resumeNotification(false, true).catch(_e => {
          // noop
        })
      } else {
        let diagnostics = this.getDiagnostics(uri)
        if (this.enabled) {
          buf.refresh(diagnostics)
          return true
        }
      }
    }
    return false
  }

  private async jumpTo(range: Range): Promise<void> {
    if (!range) return
    let { start } = range
    await this.nvim.call('cursor', [start.line + 1, start.character + 1])
    await this.echoMessage()
  }
}

export default new DiagnosticManager()
