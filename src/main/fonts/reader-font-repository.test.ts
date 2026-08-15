import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReaderFontRepository } from './reader-font-repository'

const directories:string[]=[]
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})

describe('ReaderFontRepository',()=>{
  it('imports, persists and deletes a local font file',()=>{
    const directory=mkdtempSync(join(tmpdir(),'origread-font-'));directories.push(directory)
    const source=join(directory,'My Reader Font.ttf');writeFileSync(source,new Uint8Array([0,1,2,3]))
    const repository=new ReaderFontRepository(join(directory,'fonts'))
    const imported=repository.importFile(source)
    expect(imported.id).toMatch(/^custom:/)
    expect(imported.name).toBe('My Reader Font')
    expect(imported.dataUrl).toMatch(/^data:font\/ttf;base64,/)
    expect(new ReaderFontRepository(join(directory,'fonts')).list()).toHaveLength(1)
    repository.delete(imported.id)
    expect(repository.list()).toEqual([])
  })

  it('rejects unsupported file types',()=>{
    const directory=mkdtempSync(join(tmpdir(),'origread-font-'));directories.push(directory)
    const source=join(directory,'font.exe');writeFileSync(source,'not a font')
    const repository=new ReaderFontRepository(join(directory,'fonts'))
    expect(()=>repository.importFile(source)).toThrow(/TTF/)
  })
})
