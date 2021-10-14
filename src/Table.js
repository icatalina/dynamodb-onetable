/*
    Table.js - DynamoDB table class

    A OneTable Table represents a single (connected) DynamoDB table
 */

import Crypto from 'crypto'
import UUID from './UUID.js'
import ULID from './ULID.js'
import {Model} from './Model.js'
import {Schema} from './Schema.js'
import {Metrics} from './Metrics.js'

/*
    AWS V2 DocumentClient methods
 */
const DocumentClientMethods = {
    delete: 'delete',
    get: 'get',
    find: 'query',
    put: 'put',
    scan: 'scan',
    update: 'update',
    batchGet: 'batchGet',
    batchWrite: 'batchWrite',
    transactGet: 'transactGet',
    transactWrite: 'transactWrite',
}

/*
    Safety string required on API to delete a table
*/
const ConfirmRemoveTable = 'DeleteTableForever'

/*
    Crypto IV length
*/
const IV_LENGTH = 16

const ReadWrite = {
    delete: 'write',
    get: 'read',
    find: 'read',
    put: 'write',
    scan: 'read',
    update: 'write',
    batchGet: 'read',
    batchWrite: 'write',
    transactGet: 'read',
    transactWrite: 'write',
}

const DynamoOps = {
    delete: 'deleteItem',
    get: 'getItem',
    find: 'query',
    put: 'putItem',
    scan: 'scan',
    update: 'updateItem',
    batchGet: 'batchGet',
    batchWrite: 'batchWrite',
    transactGet: 'transactGet',
    transactWrite: 'transactWrite',
}

const GenericModel = '_Generic'

/*
    Represent a single DynamoDB table
 */
export class Table {

    constructor(params = {}) {
        if (!params.name) {
            throw new Error('Missing "name" property')
        }
        this.context = {}

        this.log = params.senselogs ? params.senselogs : new Log(params.logger)
        this.log.trace(`Loading OneTable`)

        if (params.client) {
            this.setClient(params.client)
        }
        if (params.crypto) {
            this.initCrypto(params.crypto)
            this.crypto = Object.assign(params.crypto)
            for (let [name, crypto] of Object.entries(this.crypto)) {
                crypto.secret = Crypto.createHash('sha256').update(crypto.password, 'utf8').digest()
                this.crypto[name] = crypto
                this.crypto[name].name = name
            }
        }
        this.setParams(params)
        this.schema = new Schema(this, params.schema)
    }

    setClient(client) {
        this.client = client
        this.V3 = client.V3
        this.service = this.V3 ? this.client : this.client.service
    }

    setParams(params) {
        /*  LEGACY 1.7.4 - remove in 2.0.0
            Set legacyUnique to the PK separator. Previously was hard coded to ':' without a 'unique' prefix.
            Now, use the delimiter with a unique prefix.
            Defaults to be ':' in 1.7.
        */
        if (params.legacyUnique == true) {
            params.legacyUnique = ':'
        }
        //  MOB - why pull apart. Why not keep in params
        this.createdField = params.createdField || 'created'
        this.delimiter = params.delimiter || '#'
        this.hidden = params.hidden != null ? params.hidden : true
        this.isoDates = params.isoDates || false
        this.nulls = params.nulls || false
        this.timestamps = params.timestamps != null ? params.timestamps : false
        this.typeField = params.typeField || '_type'
        this.updatedField = params.updatedField || 'updated'

        /*
            Preserve prior values for items that may have callback functions (intercept, metrics.properties, uuid)
            If a schema loads new params, then need to preserve these callback functions.
        */
        this.name = params.name || this.name

        //  DEPRECATE
        this.intercept = params.intercept || this.intercept
        this.transform = params.transform || this.transform

        if (params.uuid == 'uuid') {
            this.makeID = this.uuid
        } else if (params.uuid == 'ulid') {
            this.makeID = this.ulid
        } else if (!this.makeID) {
            //  Need to have uuid the default so browsers will resolve without node:crypto
            this.makeID = params.uuid || this.makeID || this.uuid
        }
        if (params.metrics) {
            this.metrics = new Metrics(this, params.metrics, this.metrics)
        }
        this.params = params
    }

    //  MOB - better if we just kept this.params
    getParams() {
        return {
            createdField: this.createdField,
            delimiter: this.delimiter,
            hidden: this.hidden,
            isoDates: this.isoDates,
            nulls: this.nulls,
            timestamps: this.timestamps,
            typeField: this.typeField,
            updatedField: this.updatedField,
            uuid: this.uuid,
        }
    }

    setSchema(schema) {
        return this.schema.setSchema(schema)
    }

    //  MOB - add to TS defs
    getCurrentSchema() {
        return this.schema.getCurrentSchema()
    }

    async getKeys() {
        return await this.schema.getKeys()
    }

    async getPrimaryKeys() {
        let keys = await this.schema.getKeys()
        return keys.primary
    }

    async readSchema() {
        return this.schema.readSchema()
    }

    async readSchemas() {
        return this.schema.readSchemas()
    }

    async removeSchema(schema) {
        return this.schema.removeSchema(schema)
    }

    async saveSchema(schema) {
        return this.schema.saveSchema(schema)
    }

    /*
        Create a DynamoDB table. Uses the current schema index definition.
        Alternatively, params may contain standard DynamoDB createTable parameters.
    */
    async createTable(params = {}) {
        let def = {
            AttributeDefinitions: [],
            KeySchema: [],
            LocalSecondaryIndexes: [],
            GlobalSecondaryIndexes: [],
            TableName: this.name,
        }
        let provisioned = params.ProvisionedThroughput
        if (provisioned) {
            def.ProvisionedThroughput = provisioned
            def.BillingMode = 'PROVISIONED'
        } else {
            def.BillingMode = 'PAY_PER_REQUEST'
        }
        let attributes = {}
        let indexes = this.schema.indexes

        for (let [name, index] of Object.entries(indexes)) {
            let collection, keys
            if (name == 'primary') {
                keys = def.KeySchema
            } else {
                if (index.hash == null || index.hash == indexes.primary.hash) {
                    collection = 'LocalSecondaryIndexes'
                    if (index.project) {
                        throw new Error('Unwanted project for LSI')
                    }
                } else {
                    collection = 'GlobalSecondaryIndexes'
                }
                keys = []
                let project, attributes
                if (Array.isArray(index.project)) {
                    project = 'INCLUDE'
                    attributes = index.project
                } else if (index.project == 'keys') {
                    project = 'KEYS_ONLY'
                } else {
                    project = 'ALL'
                }
                let projDef = {
                    IndexName: name,
                    KeySchema: keys,
                    Projection: {
                        ProjectionType: project,
                    }
                }
                if (attributes) {
                    projDef.Projection.NonKeyAttributes = attributes
                }
                def[collection].push(projDef)
            }
            keys.push({
                AttributeName: index.hash || indexes.primary.hash,
                KeyType: 'HASH',
            })
            if (index.hash && !attributes[index.hash]) {
                def.AttributeDefinitions.push({
                    AttributeName: index.hash,
                    AttributeType: 'S',
                })
                attributes[index.hash] = true
            }
            if (index.sort) {
                if (!attributes[index.sort]) {
                    def.AttributeDefinitions.push({
                        AttributeName: index.sort,
                        AttributeType: 'S',
                    })
                    attributes[index.sort] = true
                }
                keys.push({
                    AttributeName: index.sort,
                    KeyType: 'RANGE',
                })
            }
        }
        if (def.GlobalSecondaryIndexes.length == 0) {
            delete def.GlobalSecondaryIndexes
        } else if (provisioned) {
            for (let index of def.GlobalSecondaryIndexes) {
                index.ProvisionedThroughput = provisioned
            }
        }
        if (def.LocalSecondaryIndexes.length == 0) {
            delete def.LocalSecondaryIndexes
        }
        this.log.trace(`OneTable createTable for "${this.name}"`, {def})
        if (this.V3) {
            return await this.service.createTable(def)
        } else {
            return await this.service.createTable(def).promise()
        }
    }

    /*
        Delete the DynamoDB table forever. Be careful.
    */
    async deleteTable(confirmation) {
        if (confirmation == ConfirmRemoveTable) {
            this.log.trace(`OneTable deleteTable for "${this.name}"`)
            if (this.V3) {
                await this.service.deleteTable({TableName: this.name})
            } else {
                await this.service.deleteTable({TableName: this.name}).promise()
            }
        } else {
            throw new Error(`Missing required confirmation "${ConfirmRemoveTable}"`)
        }
    }

    /*
        Return the raw AWS table description
    */
    async describeTable() {
        if (this.V3) {
            return await this.service.describeTable({TableName: this.name})
        } else {
            return await this.service.describeTable({TableName: this.name}).promise()
        }
    }

    /*
        Return true if the underlying DynamoDB table represented by this OneTable instance is present.
    */
    async exists() {
        let results = await this.listTables()
        return results && results.find(t => t == this.name) != null ? true : false
    }

    /*
        Return a list of tables in the AWS region described by the Table instance
    */
    async listTables() {
        let results
        if (this.V3) {
            results = await this.service.listTables({})
        } else {
            results = await this.service.listTables({}).promise()
        }
        return results.TableNames
    }

    listModels() {
        return this.schema.listModels()
    }

    addModel(name, fields) {
        this.schema.addModel(name, fields)
    }

    getLog() {
        return this.log
    }

    setLog(log) {
        this.log = log
    }

    /*
        Thows exception if model cannot be found
     */
    getModel(name) {
        return this.schema.getModel(name)
    }

    removeModel(name) {
        return this.schema.removeModel(name)
    }

    getContext() {
        return this.context
    }

    addContext(context = {}) {
        this.context = Object.assign(this.context, context)
        return this
    }

    setContext(context = {}, merge = false) {
        this.context = merge ? Object.assign(this.context, context) : context
        return this
    }

    clearContext() {
        this.context = {}
        return this
    }

    //  DEPRECATE in 2.0
    clear() {
        return this.clearContext()
    }

    /*  PROTOTYPE
        Create a clone of the table with the same settings and replace the context
    */
    child(context) {
        let table = JSON.parse(JSON.stringify(this))
        table.context  = context
        return table
    }

    /*
        High level model factory API
        The high level API is similar to the Model API except the model name is provided as the first parameter.
        This API is useful for factories
    */
    async create(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.create(properties, params)
    }

    async find(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.find(properties, params)
    }

    async get(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.get(properties, params)
    }

    async remove(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.remove(properties, params)
    }

    async scan(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.scan(properties, params)
    }

    async update(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.update(properties, params)
    }

    async execute(model, op, cmd, params = {}, properties = {}) {
        let mark = new Date()
        let trace = {model, cmd, op, properties}
        let result
        try {
            if (params.stats || this.metrics) {
                cmd.ReturnConsumedCapacity = params.capacity || 'INDEXES'
                cmd.ReturnItemCollectionMetrics = 'SIZE'
            }
            this.log[params.log ? 'info' : 'trace'](`OneTable "${op}" "${model}"`, {trace})
            if (this.V3) {
                result = await this.client[op](cmd)
            } else {
                result = await this.client[DocumentClientMethods[op]](cmd).promise()
            }

        } catch (err) {
            if (params.throw === false) {
                result = {}

            } else if (err.code == 'ConditionalCheckFailedException' && op == 'put') {
                //  Not a hard error -- typically part of normal operation
                this.log.info(`Conditional check failed "${op}" on "${model}"`, {err, trace})
                throw new Error(`Conditional create failed for "${model}`)

            } else {
                result = result || {}
                result.Error = 1
                trace.err = err
                if (params.log != false) {
                    this.log.error(`OneTable exception in "${op}" on "${model}"`, {err, trace})
                }
                throw err
            }

        } finally {
            if (result && this.metrics) {
                this.metrics.add(model, op, result, params, mark)
            }
        }
        if (typeof params.info == 'object') {
            params.info.operation = DynamoOps[op]
            params.info.args = cmd
            params.info.properties = properties
        }
        return result
    }

    /*
        The low level API does not use models. It permits the reading / writing of any attribute.
    */
    async batchGet(batch, params = {}) {
        if (Object.getOwnPropertyNames(batch).length == 0) {
            return []
        }
        batch.ConsistentRead = params.consistent ? true : false

        let result = await this.execute(GenericModel, 'batchGet', batch, {}, params)

        let response = result.Responses
        if (params.parse && response) {
            result = []
            for (let items of Object.values(response)) {
                for (let item of items) {
                    item = this.unmarshall(item)
                    let type = item[this.typeField] || '_unknown'
                    let model = this.schema.models[type]
                    if (model && model != this.schema.uniqueModel) {
                        result.push(model.transformReadItem('get', item, {}, params))
                    }
                }
            }
        }
        return result
    }

    async batchWrite(batch, params = {}) {
        if (Object.getOwnPropertyNames(batch).length == 0) {
            return {}
        }
        return await this.execute(GenericModel, 'batchWrite', batch, params)
    }

    async deleteItem(properties, params) {
        return await this.schema.genericModel.deleteItem(properties, params)
    }

    async getItem(properties, params) {
        return await this.schema.genericModel.getItem(properties, params)
    }

    async putItem(properties, params) {
        return await this.schema.genericModel.putItem(properties, params)
    }

    async queryItems(properties, params) {
        return await this.schema.genericModel.queryItems(properties, params)
    }

    async scanItems(properties, params) {
        return await this.schema.genericModel.scanItems(properties, params)
    }

    async updateItem(properties, params) {
        return await this.schema.genericModel.updateItem(properties, params)
    }

    async fetch(models, properties, params) {
        return await this.schema.genericModel.fetch(models, properties, params)
    }

    /*
        Invoke a prepared transaction. Note: transactGet does not work on non-primary indexes.
     */
    async transact(op, transaction, params = {}) {
        let result = await this.execute(GenericModel, op == 'write' ? 'transactWrite' : 'transactGet', transaction, params)
        if (op == 'get') {
            if (params.parse) {
                let items = []
                for (let r of result.Responses) {
                    if (r.Item) {
                        let item = this.unmarshall(r.Item)
                        let type = item[this.typeField] || '_unknown'
                        let model = this.schema.models[type]
                        if (model && model != this.schema.uniqueModel) {
                            items.push(model.transformReadItem('get', item, {}, params))
                        }
                    }
                }
                result = items
            }
        }
        return result
    }

    /*
        Convert items into a map of items by model type
    */
    groupByType(items) {
        let result = {}
        for (let item of items) {
            let type = item[this.typeField] || '_unknown'
            let list = result[type] = result[type] || []
            list.push(item)
        }
        return result
    }

    /*
        Simple non-crypto UUID. See node-uuid if you require crypto UUIDs.
        Consider ULIDs which are crypto sortable.
    */
    uuid() {
        return UUID()
    }

    // Simple time-based, sortable unique ID.
    ulid() {
        return new ULID().toString()
    }

    setMakeID(fn) {
        this.makeID = fn
    }

    /*
        Return the value template variable references in a list
     */
    getVars(v) {
        let list = []
        if (Array.isArray(v)) {
            list = v
        } else if (typeof v != 'function') {
            //  FUTURE - need 'depends' to handle function dependencies
            v.replace(/\${(.*?)}/g, (match, varName) => {
                list.push(varName)
            })
        }
        return list
    }

    initCrypto(crypto) {
        this.crypto = Object.assign(crypto)
        for (let [name, crypto] of Object.entries(this.crypto)) {
            crypto.secret = Crypto.createHash('sha256').update(crypto.password, 'utf8').digest()
            this.crypto[name] = crypto
            this.crypto[name].name = name
        }
    }

    encrypt(text, name = 'primary', inCode = 'utf8', outCode = 'base64') {
        if (text) {
            if (!this.crypto) {
                throw new Error('dynamo: No database secret or cipher defined')
            }
            let crypto = this.crypto[name]
            if (!crypto) {
                throw new Error(`dynamo: Database crypto not defined for ${name}`)
            }
            let iv = Crypto.randomBytes(IV_LENGTH)
            let crypt = Crypto.createCipheriv(crypto.cipher, crypto.secret, iv)
            let crypted = crypt.update(text, inCode, outCode) + crypt.final(outCode)
            let tag = (crypto.cipher.indexOf('-gcm') > 0) ? crypt.getAuthTag().toString(outCode) : ''
            text = `${crypto.name}:${tag}:${iv.toString('hex')}:${crypted}`
        }
        return text
    }

    decrypt(text, inCode = 'base64', outCode = 'utf8') {
        if (text) {
            let [name, tag, iv, data] = text.split(':')
            if (!data || !iv || !tag || !name) {
                return text
            }
            if (!this.crypto) {
                throw new Error('dynamo: No database secret or cipher defined')
            }
            let crypto = this.crypto[name]
            if (!crypto) {
                throw new Error(`dynamo: Database crypto not defined for ${name}`)
            }
            iv = Buffer.from(iv, 'hex')
            let crypt = Crypto.createDecipheriv(crypto.cipher, crypto.secret, iv)
            crypt.setAuthTag(Buffer.from(tag, inCode))
            text = crypt.update(data, inCode, outCode) + crypt.final(outCode)
        }
        return text
    }

    /*
        Marshall data into and out of DynamoDB format
    */
    marshall(item) {
        let client = this.client
        if (client.V3) {
            let options = client.params.marshall
            if (Array.isArray(item)) {
                for (let i = 0; i < item.length; i++) {
                    item[i] = client.marshall(item[i], options)
                }
            } else {
                item = client.marshall(item, options)
            }
        } else {
            if (Array.isArray(item)) {
                for (let i = 0; i < item.length; i++) {
                    item = this.marshallv2(item)
                }
            } else {
                item = this.marshallv2(item)
            }
        }
        return item
    }

    /*
        Marshall data out of DynamoDB format
    */
    unmarshall(item) {
        if (this.V3) {
            let client = this.client
            let options = client.params.unmarshall
            if (Array.isArray(item)) {
                for (let i = 0; i < item.length; i++) {
                    item[i] = client.unmarshall(item[i], options)
                }
            } else {
                item = client.unmarshall(item, options)
            }
        } else {
            if (Array.isArray(item)) {
                for (let i = 0; i < item.length; i++) {
                    item[i] = this.unmarshallv2(item[i])
                }
            } else {
                item = this.unmarshallv2(item)
            }

        }
        return item
    }

    marshallv2(item) {
        for (let [key, value] of Object.entries(item)) {
            if (value instanceof Set) {
                item[key] = this.client.createSet(Array.from(value))
                /*
                let first = value.values().next().value
                if (typeof first == 'number') {
                    item[key] = { NS: Array.from(value).map(v => v) }
                } else if (first instanceof Buffer || first instanceof ArrayBuffer) {
                    item[key] = { BS: Array.from(value).map(v => v.toString('base64')) }
                } else {
                    item[key] = { SS: Array.from(value).map(v => v.toString()) }
                } */
            }
        }
        return item
    }

    unmarshallv2(item) {
        for (let [key, value] of Object.entries(item)) {
            if (value != null && typeof value == 'object' && value.wrapperName == 'Set' && Array.isArray(value.values)) {
                let list = value.values
                if (value.type == 'Binary') {
                    //  Match AWS SDK V3 behavior
                    list = list.map(v => new Uint8Array(v))
                }
                item[key] = new Set(list)
            }
        }
        return item
    }

    mergeOne(recurse, dest, src) {
        if (recurse++ > 50) {
            throw new Error('Recursive clone')
        }
        for (let [key, value] of Object.entries(src)) {
            if (value === undefined) {
                continue

            } else if (value instanceof Date) {
                dest[key] = new Date(value)

            } else if (value instanceof RegExp) {
                dest[key] = new RegExp(value.source, value.flags)

            } else if (Array.isArray(value)) {
                if (!Array.isArray(dest[key])) {
                    dest[key] = []
                }
                dest[key] = this.mergeOne(recurse, dest[key], value)

            } else if (typeof value == 'object' && !(value instanceof RegExp || value == null)) {
                if (typeof dest[key] != 'object') {
                    dest[key] = {}
                }
                dest[key] = this.mergeOne(recurse, dest[key], value)

            } else {
                dest[key] = value
            }
        }
        return dest
    }

    merge(dest, ...sources) {
        for (let src of sources) {
            dest = this.mergeOne(0, dest, src)
        }
        return dest
    }
}

/*
    Emulate SenseLogs API
*/
class Log {
    constructor(logger) {
        if (logger === true) {
            this.logger = this.defaultLogger
        } else if (logger) {
            this.logger = logger
        }
    }

    enabled() {
        return true
    }

    data(message, context) {
        this.process('data', message, context)
    }

    emit(chan, message, context) {
        this.process(chan, message, context)
    }

    error(message, context) {
        this.process('error', message, context)
    }

    info(message, context) {
        this.process('info', message, context)
    }

    trace(message, context) {
        this.process('trace', message, context)
    }

    process(level, message, context) {
        if (this.logger) {
            this.logger(level, message, context)
        }
    }

    defaultLogger(level, message, context) {
        if (level == 'trace' || level == 'data') {
            //  params.log: true will cause the level to be changed to 'info'
            return
        }
        if (context) {
            console.log(level, message, JSON.stringify(context, null, 4))
        } else {
            console.log(level, message)
        }
    }
}
