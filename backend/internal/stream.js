const _                   = require('lodash');
const error               = require('../lib/error');
const utils               = require('../lib/utils');
const streamModel         = require('../models/stream');
const internalNginx       = require('./nginx');
const internalAuditLog    = require('./audit-log');
const internalCertificate = require('./certificate');
const internalHost        = require('./host');
const {castJsonIfNeed}    = require('../lib/helpers');

function omissions () {
	return ['is_deleted', 'owner.is_deleted', 'certificate.is_deleted'];
}

const internalStream = {

	/**
	 * @param   {Access}  access
	 * @param   {Object}  data
	 * @returns {Promise}
	 */
	create: (access, data) => {
		const create_certificate = data.certificate_id === 'new';

		if (create_certificate) {
			delete data.certificate_id;
		}

		return access.can('streams:create', data)
			.then((/*access_data*/) => {
				// TODO: At this point the existing ports should have been checked
				data.owner_user_id = access.token.getUserId(1);

				if (typeof data.meta === 'undefined') {
					data.meta = {};
				}

				// streams aren't routed by domain name so don't store domain names in the DB
				let data_no_domains = structuredClone(data);
				delete data_no_domains.domain_names;

				return streamModel
					.query()
					.insertAndFetch(data_no_domains)
					.then(utils.omitRow(omissions()));
			})
			.then((row) => {
				if (create_certificate) {
					return internalCertificate.createQuickCertificate(access, data)
						.then((cert) => {
							// update host with cert id
							return internalStream.update(access, {
								id:             row.id,
								certificate_id: cert.id
							});
						})
						.then(() => {
							return row;
						});
				} else {
					return row;
				}
			})
			.then((row) => {
				// re-fetch with cert
				return internalStream.get(access, {
					id:     row.id,
					expand: ['certificate', 'owner']
				});
			})
			.then((row) => {
				// Configure nginx
				return internalNginx.configure(streamModel, 'stream', row)
					.then(() => {
						return row;
					});
			})
			.then((row) => {
				// Add to audit log
				return internalAuditLog.add(access, {
					action:      'created',
					object_type: 'stream',
					object_id:   row.id,
					meta:        data
				})
					.then(() => {
						return row;
					});
			});
	},

	/**
	 * @param  {Access}  access
	 * @param  {Object}  data
	 * @param  {Number}  data.id
	 * @return {Promise}
	 */
	update: (access, data) => {
		const create_certificate = data.certificate_id === 'new';

		if (create_certificate) {
			delete data.certificate_id;
		}

		return access.can('streams:update', data.id)
			.then((/*access_data*/) => {
				// TODO: at this point the existing streams should have been checked
				return internalStream.get(access, {id: data.id});
			})
			.then((row) => {
				if (row.id !== data.id) {
					// Sanity check that something crazy hasn't happened
					throw new error.InternalValidationError('Stream could not be updated, IDs do not match: ' + row.id + ' !== ' + data.id);
				}

				if (create_certificate) {
					return internalCertificate.createQuickCertificate(access, {
						domain_names: data.domain_names || row.domain_names,
						meta:         _.assign({}, row.meta, data.meta)
					})
						.then((cert) => {
							// update host with cert id
							data.certificate_id = cert.id;
						})
						.then(() => {
							return row;
						});
				} else {
					return row;
				}
			})
			.then((row) => {
				// Add domain_names to the data in case it isn't there, so that the audit log renders correctly. The order is important here.
				data = _.assign({}, {
					domain_names: row.domain_names
				}, data);

				return streamModel
					.query()
					.patchAndFetchById(row.id, data)
					.then(utils.omitRow(omissions()))
					.then((saved_row) => {
						// Add to audit log
						return internalAuditLog.add(access, {
							action:      'updated',
							object_type: 'stream',
							object_id:   row.id,
							meta:        data
						})
							.then(() => {
								return saved_row;
							});
					});
			})
			.then(() => {
				return internalStream.get(access, {id: data.id, expand: ['owner', 'certificate']})
					.then((row) => {
						return internalNginx.configure(streamModel, 'stream', row)
							.then((new_meta) => {
								row.meta = new_meta;
								row      = internalHost.cleanRowCertificateMeta(row);
								return _.omit(row, omissions());
							});
					});
			});
	},

	/**
	 * @param  {Access}   access
	 * @param  {Object}   data
	 * @param  {Number}   data.id
	 * @param  {Array}    [data.expand]
	 * @param  {Array}    [data.omit]
	 * @return {Promise}
	 */
	get: (access, data) => {
		if (typeof data === 'undefined') {
			data = {};
		}

		return access.can('streams:get', data.id)
			.then((access_data) => {
				let query = streamModel
					.query()
					.where('is_deleted', 0)
					.andWhere('id', data.id)
					.allowGraph('[owner,certificate]')
					.first();

				if (access_data.permission_visibility !== 'all') {
					query.andWhere('owner_user_id', access.token.getUserId(1));
				}

				if (typeof data.expand !== 'undefined' && data.expand !== null) {
					query.withGraphFetched('[' + data.expand.join(', ') + ']');
				}

				return query.then(utils.omitRow(omissions()));
			})
			.then((row) => {
				if (!row || !row.id) {
					throw new error.ItemNotFoundError(data.id);
				}
				row = internalHost.cleanRowCertificateMeta(row);
				// Custom omissions
				if (typeof data.omit !== 'undefined' && data.omit !== null) {
					row = _.omit(row, data.omit);
				}
				return row;
			});
	},

	/**
	 * @param {Access}  access
	 * @param {Object}  data
	 * @param {Number}  data.id
	 * @param {String}  [data.reason]
	 * @returns {Promise}
	 */
	delete: (access, data) => {
		return access.can('streams:delete', data.id)
			.then(() => {
				return internalStream.get(access, {id: data.id});
			})
			.then((row) => {
				if (!row || !row.id) {
					throw new error.ItemNotFoundError(data.id);
				}

				return streamModel
					.query()
					.where('id', row.id)
					.patch({
						is_deleted: 1
					})
					.then(() => {
						// Delete Nginx Config
						return internalNginx.deleteConfig('stream', row)
							.then(() => {
								return internalNginx.reload();
							});
					})
					.then(() => {
						// Add to audit log
						return internalAuditLog.add(access, {
							action:      'deleted',
							object_type: 'stream',
							object_id:   row.id,
							meta:        _.omit(row, omissions())
						});
					});
			})
			.then(() => {
				return true;
			});
	},

	/**
	 * @param {Access}  access
	 * @param {Object}  data
	 * @param {Number}  data.id
	 * @param {String}  [data.reason]
	 * @returns {Promise}
	 */
	enable: (access, data) => {
		return access.can('streams:update', data.id)
			.then(() => {
				return internalStream.get(access, {
					id:     data.id,
					expand: ['certificate', 'owner']
				});
			})
			.then((row) => {
				if (!row || !row.id) {
					throw new error.ItemNotFoundError(data.id);
				} else if (row.enabled) {
					throw new error.ValidationError('Stream is already enabled');
				}

				row.enabled = 1;

				return streamModel
					.query()
					.where('id', row.id)
					.patch({
						enabled: 1
					})
					.then(() => {
						// Configure nginx
						return internalNginx.configure(streamModel, 'stream', row);
					})
					.then(() => {
						// Add to audit log
						return internalAuditLog.add(access, {
							action:      'enabled',
							object_type: 'stream',
							object_id:   row.id,
							meta:        _.omit(row, omissions())
						});
					});
			})
			.then(() => {
				return true;
			});
	},

	/**
	 * @param {Access}  access
	 * @param {Object}  data
	 * @param {Number}  data.id
	 * @param {String}  [data.reason]
	 * @returns {Promise}
	 */
	disable: (access, data) => {
		return access.can('streams:update', data.id)
			.then(() => {
				return internalStream.get(access, {id: data.id});
			})
			.then((row) => {
				if (!row || !row.id) {
					throw new error.ItemNotFoundError(data.id);
				} else if (!row.enabled) {
					throw new error.ValidationError('Stream is already disabled');
				}

				row.enabled = 0;

				return streamModel
					.query()
					.where('id', row.id)
					.patch({
						enabled: 0
					})
					.then(() => {
						// Delete Nginx Config
						return internalNginx.deleteConfig('stream', row)
							.then(() => {
								return internalNginx.reload();
							});
					})
					.then(() => {
						// Add to audit log
						return internalAuditLog.add(access, {
							action:      'disabled',
							object_type: 'stream-host',
							object_id:   row.id,
							meta:        _.omit(row, omissions())
						});
					});
			})
			.then(() => {
				return true;
			});
	},

	/**
	 * All Streams
	 *
	 * @param   {Access}  access
	 * @param   {Array}   [expand]
	 * @param   {String}  [search_query]
	 * @returns {Promise}
	 */
	getAll: (access, expand, search_query) => {
		return access.can('streams:list')
			.then((access_data) => {
				const query = streamModel
					.query()
					.where('is_deleted', 0)
					.groupBy('id')
					.allowGraph('[owner,certificate]')
					.orderBy('incoming_port', 'ASC');

				if (access_data.permission_visibility !== 'all') {
					query.andWhere('owner_user_id', access.token.getUserId(1));
				}

				// Query is used for searching
				if (typeof search_query === 'string' && search_query.length > 0) {
					query.where(function () {
						this.where(castJsonIfNeed('incoming_port'), 'like', `%${search_query}%`);
					});
				}

				if (typeof expand !== 'undefined' && expand !== null) {
					query.withGraphFetched('[' + expand.join(', ') + ']');
				}

				return query.then(utils.omitRows(omissions()));
			})
			.then((rows) => {
				if (typeof expand !== 'undefined' && expand !== null && expand.indexOf('certificate') !== -1) {
					return internalHost.cleanAllRowsCertificateMeta(rows);
				}

				return rows;
			});
	},

	/**
	 * Report use
	 *
	 * @param   {Number}  user_id
	 * @param   {String}  visibility
	 * @returns {Promise}
	 */
	getCount: (user_id, visibility) => {
		const query = streamModel
			.query()
			.count('id AS count')
			.where('is_deleted', 0);

		if (visibility !== 'all') {
			query.andWhere('owner_user_id', user_id);
		}

		return query.first()
			.then((row) => {
				return parseInt(row.count, 10);
			});
	}
};

module.exports = internalStream;
