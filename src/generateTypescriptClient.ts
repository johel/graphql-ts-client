import Case from 'case'
import fs, { PathLike } from 'fs'
import { introspectionQuery, IntrospectionQuery } from 'graphql'
import { GraphQLClient } from 'graphql-request'
import { Options } from 'graphql-request/dist/src/types'
import {
  IntrospectionEnumType,
  IntrospectionField,
  IntrospectionInputObjectType,
  IntrospectionInputTypeRef,
  IntrospectionObjectType,
  IntrospectionOutputTypeRef,
  IntrospectionType,
} from 'graphql/utilities/introspectionQuery'
import orderBy from 'lodash.orderby'
import set from 'lodash.set'
import * as prettier from 'prettier'

enum Scalars {
  number = 'number',
  IDate = 'IDate',
  boolean = 'boolean',
  UUID = 'UUID',
  string = 'string',
}

function gqlScalarToTypescript(gqlType: string) {
  if (/(int|long|double|decimal)/i.test(gqlType)) return 'number'
  if (/date/i.test(gqlType)) return 'IDate'
  if (/boolean/i.test(gqlType)) return 'boolean'
  if (/uuid/i.test(gqlType)) return 'UUID'

  return 'string'
}

// TODO: separate in two: input and output types
function gqlTypeToTypescript(
  gqlType: IntrospectionOutputTypeRef,
  { required = false, isInput = false, selection = false } = {}
): string {
  if (!gqlType) return ''

  const maybeWrapped = (it: string) => (required || selection ? it : `Maybe<${it}>`)

  // noinspection SuspiciousTypeOfGuard
  if (typeof gqlType === 'string') {
    return maybeWrapped(gqlType)
  }

  if (gqlType.kind.endsWith('OBJECT')) {
    return maybeWrapped((gqlType as any).name + (selection ? 'Selection' : ''))
  }

  if (gqlType.kind === 'NON_NULL') {
    return `${gqlTypeToTypescript(gqlType.ofType, {
      isInput,
      required: true,
      selection,
    })}`
  }

  if (gqlType.kind === 'LIST') {
    return maybeWrapped(
      `${gqlTypeToTypescript(gqlType.ofType, {
        isInput,
        required: true,
        selection,
      })}${selection ? '' : '[]'}`
    )
  }

  if (selection) {
    return ''
  }

  if (gqlType.kind === 'ENUM' && gqlType.name) {
    return maybeWrapped(gqlType.name)
  }

  if (gqlType.kind === 'SCALAR') {
    return maybeWrapped(gqlScalarToTypescript(gqlType.name))
  }

  return ''
}

function gqlFieldToTypescript(it: IntrospectionField, { isInput, selection }: { isInput: boolean; selection: boolean }): string {
  let fieldTypeDefinition = gqlTypeToTypescript(it.type, {
    isInput,
    selection,
  })

  fieldTypeDefinition = fieldTypeDefinition in Scalars && selection ? '' : `${fieldTypeDefinition}`

  if (selection && it.args && it.args.length) {
    let fieldsOnArgs = it.args.map((_: any) => gqlFieldToTypescript(_, { isInput: true, selection: false })).join(', ')

    fieldTypeDefinition = `{ __args: { ${fieldsOnArgs} }}${fieldTypeDefinition ? ` & ${fieldTypeDefinition}` : ''}`
  }

  const isOptional = selection || fieldTypeDefinition.startsWith('Maybe')
  const finalType = fieldTypeDefinition || (selection && 'boolean')
  return `${it.name}${isOptional ? '?:' : ':'} ${isOptional ? (finalType as string).replace(/Maybe\<(.+?)\>/, '$1') : finalType}`
}

function gqlEndpointToTypescript(kind: 'mutation' | 'query', it: IntrospectionField): string {
  let selectionType = gqlTypeToTypescript(it.type, {
    isInput: false,
    selection: true,
  })

  if (it.args && it.args.length) {
    const fieldsOnArgs = it.args.map((_: any) => gqlFieldToTypescript(_, { isInput: true, selection: false })).join(', ')

    selectionType = `{ __args: { ${fieldsOnArgs} }}${selectionType ? ` & ${selectionType}` : ''}`
  }

  const outputType = gqlTypeToTypescript(it.type)
  const wrappedOutputType = /^(UUID|IDate|string|number|boolean)$/.test(outputType) ? outputType : `DeepRequired<${outputType}>`
  const inputType = selectionType || 'undefined'

  return `${it.name}: apiEndpoint<${inputType}, ${wrappedOutputType}>('${kind}', '${it.name}')`
}

function gqlSchemaToTypescript(
  it: any | IntrospectionObjectType | IntrospectionInputObjectType | IntrospectionEnumType,
  { selection = false }
) {
  const rawKind = it.kind || it.type

  if (rawKind === 'ENUM')
    return `
      export enum ${it.name} {
        ${orderBy(it.enumValues, 'name')
          .map((_: any) => `${Case.camel(_.name)} = '${_.name}'`)
          .join(',\n  ')}
      }`

  const fields = (it.fields && it.fields) || (it.inputFields && it.inputFields) || []

  return `
    export interface ${it.name}${selection ? 'Selection' : ''} {
      ${fields
        .map((_: any) =>
          gqlFieldToTypescript(_, {
            isInput: it.kind === 'INPUT_OBJECT',
            selection,
          })
        )
        .join(',\n  ')}
    }`
}

function getGraphQLInputType(type: IntrospectionInputTypeRef): string {
  switch (type.kind) {
    case 'NON_NULL':
      return `${getGraphQLInputType(type.ofType)}!`

    case 'SCALAR':
    case 'INPUT_OBJECT':
    case 'ENUM':
      return type.name

    case 'LIST':
      return `[${getGraphQLInputType(type.ofType)}]`

    default:
      return ''
  }
}

function getGraphQLOutputType(type: IntrospectionOutputTypeRef): string {
  switch (type.kind) {
    case 'LIST':
      return `${getGraphQLOutputType(type.ofType)}[]`

    case 'NON_NULL':
      return getGraphQLOutputType(type.ofType)

    case 'OBJECT':
      return type.name

    default:
      return ''
  }
}

function getTypesTreeCode(types: IntrospectionObjectType[]) {
  const typesTree = {}

  types.forEach(type =>
    type.fields
      .filter(_ => _.args && _.args.length)
      .forEach(_ =>
        _.args.forEach(a => {
          let inputType = getGraphQLInputType(a.type)
          if (inputType) {
            set(typesTree, `${type.name}.${_.name}.__args.${a.name}`, inputType)
          }
        })
      )
  )

  types.forEach(t =>
    t.fields.forEach(f => {
      let outputType = getGraphQLOutputType(f.type)
      if (outputType) {
        set(typesTree, `${t.name}.${f.name}.__shape`, outputType)
      }
    })
  )

  return `
    const typesTree = {
      ${Object.entries(typesTree)
        .map(([key, value]) => {
          let entryCode = Object.entries(value as any)
            .map(([k, v]: any) => {
              const cleanShapeType = v.__shape && v.__shape.replace(/[\[\]!?]/g, '')
              const fieldsCode =
                v.__shape && typesTree.hasOwnProperty(cleanShapeType) ? `__fields: typesTree.${cleanShapeType},` : ''

              const argsCode = v.__args
                ? `__args: {
                      ${Object.entries(v.__args)
                        .map(([k, v]) => `${k}: '${v}'`)
                        .join(',\n')}
                    }`
                : ''

              return fieldsCode || argsCode
                ? `get ${k}(): any {
                  return {
                    ${fieldsCode}
                    ${argsCode}
                  }
                }`
                : `${k}: {}`
            })
            .filter(Boolean)
            .join(',\n')
            .trim()
          return (
            entryCode &&
            `
              ${key}: { 
                ${entryCode} 
              }`
          )
        })
        .filter(Boolean)
        .join(',\n')}
    }
  `
}

type IClientOptions = Options & { output: PathLike; endpoint: string; verbose?: boolean; formatGraphQL?: boolean }

function generateClientCode(types: ReadonlyArray<IntrospectionType>, options: IClientOptions, endpoint: string) {
  const queries = (<IntrospectionObjectType>types.find(it => it.name === 'Query'))?.fields || []
  const mutations = (<IntrospectionObjectType>types.find(it => it.name === 'Mutation'))?.fields || []
  const enums = types.filter(it => it.kind === 'ENUM' && !it.name.startsWith('__')) as IntrospectionEnumType[]
  const objectTypes = types.filter(it => ['OBJECT', 'INPUT_OBJECT'].includes(it.kind) && !it.name.startsWith('__')) as (
    | IntrospectionObjectType
    | IntrospectionInputObjectType
  )[]

  const forInputExtraction = types.filter(
    it => !it.name.startsWith('__') && ['OBJECT'].includes(it.kind)
  ) as IntrospectionObjectType[]

  // language=TypeScript
  const clientCode = `
      import { DeepRequired } from 'ts-essentials'
      import { GraphQLClient } from 'graphql-request'
      import { Options } from 'graphql-request/dist/src/types'
      import { getApiEndpointCreator } from 'graphql-ts-client/dist/endpoint'
      import { UUID, IDate, Maybe, IResponseListener } from 'graphql-ts-client/dist/types'
      
      ${
        options.formatGraphQL || options.verbose
          ? `
      import prettier from "prettier/standalone"
      import parserGraphql from "prettier/parser-graphql"
      
      const formatGraphQL = (query: string) => prettier.format(query, {parser: 'graphql', plugins: [parserGraphql]})`
          : `
      const formatGraphQL = (query: string) => query`
      }
  
      // Enums
      ${enums.map(it => gqlSchemaToTypescript(it, { selection: false })).join('\n')}
      
      // Input Types
      ${objectTypes.map(it => gqlSchemaToTypescript(it, { selection: false })).join('\n')}
      
      // Selection Types
      ${objectTypes.map(it => gqlSchemaToTypescript(it, { selection: true })).join('\n')}
      
      // Schema Resolution Tree
      ${getTypesTreeCode(forInputExtraction)}
  
      let verbose = ${Boolean(options.verbose)}
      let client = new GraphQLClient('${endpoint}')
      let responseListeners: IResponseListener[] = []
      let apiEndpoint = getApiEndpointCreator({ 
        getClient: () => client, 
        responseListeners, 
        maxAge: 30000, 
        verbose, 
        typesTree, 
        formatGraphQL 
      })
  
      export default {
        setClient: (url: string, options?: Options) => { client = new GraphQLClient(url, options) },
        addResponseListener: (listener: IResponseListener) => responseListeners.push(listener),
        setHeader: (key: string, value: string) => { client.setHeader(key, value) },
        setHeaders: (headers: { [k: string]: string }) => { client.setHeaders(headers) },
        queries: {
          ${queries.map(q => gqlEndpointToTypescript('query', q)).join(',\n  ')}
        },
        mutations: {
          ${mutations.map(q => gqlEndpointToTypescript('mutation', q)).join(',\n  ')}
        }
      }`

  return prettier.format(clientCode, { semi: false, parser: 'typescript' })
}

export async function generateTypescriptClient({ endpoint, output, ...options }: IClientOptions): Promise<void> {
  try {
    const client = new GraphQLClient(endpoint, options)

    const {
      __schema: { types },
    } = (await client.request(introspectionQuery)) as IntrospectionQuery

    const formattedClientCode = generateClientCode(types, options as IClientOptions, endpoint)

    fs.writeFileSync(output, formattedClientCode, { encoding: 'utf8' })
  } catch (e) {
    console.error('\nThe GraphQL introspection request failed\n')
    console.error(e.response || e)

    throw e
  }
}
