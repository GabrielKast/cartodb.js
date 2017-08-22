var _ = require('underscore');
var Backbone = require('backbone');
var d3 = require('d3');
var moment = require('moment');
var DataviewModelBase = require('./dataview-model-base');
var HistogramDataModel = require('./histogram-dataview/histogram-data-model');
var helper = require('./helpers/histogram-helper');
var dateUtils = require('../util/date-utils');

module.exports = DataviewModelBase.extend({

  defaults: _.extend(
    {
      type: 'histogram',
      totalAmount: 0,
      filteredAmount: 0,
      hasNulls: false,
      localTimezone: false
    },
    DataviewModelBase.prototype.defaults
  ),

  _getDataviewSpecificURLParams: function () {
    var params = [];

    if (_.isNumber(this.get('own_filter'))) {
      params.push('own_filter=' + this.get('own_filter'));
    } else {
      var offset = this._getCurrentOffset();

      if (this.get('column_type') === 'number' && this.get('bins')) {
        params.push('bins=' + this.get('bins'));
      } else if (this.get('column_type') === 'date') {
        params.push('aggregation=' + (this.get('aggregation') || 'auto'));
        if (_.isFinite(offset)) {
          params.push('offset=' + offset);
        }
      }

      // Start - End
      var msg = 'Pedimos dataview con [';
      var limits = this._originalData.getCurrentStartEnd();
      if (_.isNumber(limits.start)) {
        params.push('start=' + limits.start);
        msg += '' + limits.start + ' ' + helper.formatUTCTimestamp(limits.start);
      }
      if (_.isNumber(limits.end)) {
        params.push('end=' + limits.end);
        msg += ' ' + limits.end + ' ' + helper.formatUTCTimestamp(limits.end);
      }
      msg += ']';
      //console.log(msg);
    }
    return params;
  },

  initialize: function (attrs, opts) {
    this._localOffset = dateUtils.getLocalOffset();

    // Internal model for calculating all the data in the histogram (without filters)
    this._originalData = new HistogramDataModel({
      bins: this.get('bins'),
      aggregation: this.get('aggregation'),
      offset: this.get('offset'),
      column_type: this.get('column_type'),
      apiKey: this.get('apiKey'),
      authToken: this.get('authToken'),
      localTimezone: this.get('localTimezone'),
      localOffset: this._localOffset
    });

    DataviewModelBase.prototype.initialize.apply(this, arguments);
    this._data = new Backbone.Collection(this.get('data'));

    if (attrs && (attrs.min || attrs.max)) {
      this.filter.setRange(this.get('min'), this.get('max'));
    }
  },

  _initBinds: function () {
    DataviewModelBase.prototype._initBinds.apply(this);

    this._updateURLBinding();

    // When original data gets fetched
    this._originalData.bind('change:data', this._onDataChanged, this);
    this._originalData.once('change:data', this._updateBindings, this);

    this.on('change:column', this._onColumnChanged, this);
    this.on('change:localTimezone', this._onLocalTimezoneChanged, this);
    this.on('change', this._onFieldsChanged, this);

    this.listenTo(this.layer, 'change:meta', this._onChangeLayerMeta);
  },

  _onLocalTimezoneChanged: function () {
    this._resetFilter();
    this._originalData.set('localTimezone', this.get('localTimezone'));
  },

  _updateURLBinding: function () {
    this.off('change:url');
    this.on('change:url', this._onUrlChanged, this);
  },

  _updateBindings: function () {
    this._onChangeBinds();
    this._updateURLBinding();
  },

  enableFilter: function () {
    this.set('own_filter', 1);
  },

  disableFilter: function () {
    this.unset('own_filter');
  },

  getData: function () {
    return this._data.toJSON();
  },

  getUnfilteredData: function () {
    return this._originalData.get('data');
  },

  getUnfilteredDataModel: function () {
    return this._originalData;
  },

  getSize: function () {
    return this._data.size();
  },

  getColumnType: function () {
    return this.get('column_type');
  },

  hasNulls: function () {
    return this.get('hasNulls');
  },

  parse: function (data) {
    var aggregation = data.aggregation;
    var numberOfBins = data.bins_count;
    var width = data.bin_width;
    var start = this.get('column_type') === 'date' ? data.timestamp_start : data.bins_start;

    var parsedData = {
      data: [],
      filteredAmount: 0,
      nulls: 0,
      totalAmount: 0
    };

    if (this.has('error')) {
      return parsedData;
    }

    parsedData.data = new Array(numberOfBins);

    _.each(data.bins, function (bin) {
      parsedData.data[bin.bin] = bin;
    });

    this.set({
      aggregation: aggregation
    }, { silent: true });

    console.log('parse dataview from ', numberOfBins);

    if (this.get('column_type') === 'date') {
      parsedData.data = helper.fillTimestampBuckets(parsedData.data, start, aggregation, numberOfBins, this._getCurrentOffset(), 'filtered', this._originalData.get('data').length);
      numberOfBins = parsedData.data.length;
      console.log('to ', numberOfBins);
    } else {
      helper.fillNumericBuckets(parsedData.data, start, width, numberOfBins);
    }

    // FIXME - Update the end of last bin due https://github.com/CartoDB/cartodb.js/issues/926
    var lastBucket = parsedData.data[numberOfBins - 1];
    if (lastBucket && lastBucket.end < lastBucket.max) {
      lastBucket.end = lastBucket.max;
    }

    // if parse option is passed in the constructor, this._data is not created yet at this point
    this._data && this._data.reset(parsedData.data);

    // Calculate totals
    parsedData.totalAmount = this._calculateTotalAmount(parsedData.data);
    parsedData.filteredAmount = this._calculateFilteredAmount(this.filter, this._data);
    parsedData.nulls = data.nulls;

    if (data.nulls != null) {
      parsedData = _.extend({}, parsedData, {
        nulls: data.nulls,
        hasNulls: true
      });
    }

    return parsedData;
  },

  _onFilterChanged: function (filter) {
    this.set('filteredAmount', this._calculateFilteredAmount(filter, this._data));

    DataviewModelBase.prototype._onFilterChanged.apply(this, arguments);
  },

  _onColumnChanged: function () {
    this._originalData.set('column_type', this.get('column_type'));
    this.set('aggregation', undefined, { silent: true });

    this._reloadVisAndForceFetch();
  },

  _calculateTotalAmount: function (buckets) {
    return _.reduce(buckets, function (memo, bucket) {
      var add = bucket && bucket.freq
        ? bucket.freq
        : 0;
      return memo + add;
    }, 0);
  },

  _calculateFilteredAmount: function (filter, data) {
    var filteredAmount = 0;
    if (filter && filter.get('min') !== void 0 && filter.get('max') !== void 0) {
      var indexes = this._findBinsIndexes(data, filter.get('min'), filter.get('max'));
      filteredAmount = this._sumBinsFreq(data, indexes.start, indexes.end);
    }

    return filteredAmount;
  },

  _findBinsIndexes: function (data, start, end) {
    var startBin = data.findWhere({ start: Math.min(start, end) });
    var endBin = data.findWhere({ end: Math.max(start, end) });

    return {
      start: startBin && startBin.get('bin'),
      end: endBin && endBin.get('bin')
    };
  },

  _sumBinsFreq: function (data, start, end) {
    return _.reduce(data.slice(start, end + 1), function (acum, d) {
      return (d.get('freq') || 0) + acum;
    }, 0);
  },

  /*
  Ported from cartodb-postgresql
  https://github.com/CartoDB/cartodb-postgresql/blob/master/scripts-available/CDB_DistType.sql
  */
  getDistributionType: function (data) {
    var histogram = data || this.get('data');
    var freqAccessor = function (a) { return a.freq; };
    var osc = d3.max(histogram, freqAccessor) - d3.min(histogram, freqAccessor);
    var mean = d3.mean(histogram, freqAccessor);
    // When the difference between the max and the min values is less than
    // 10 percent of the mean, it's a flat histogram (F)
    if (osc < mean * 0.1) return 'F';
    var sumFreqs = d3.sum(histogram, freqAccessor);
    var freqs = histogram.map(function (bin) {
      return 100 * bin.freq / sumFreqs;
    });

    // The ajus array represents relative growths
    var ajus = freqs.map(function (freq, index) {
      var next = freqs[index + 1];
      if (freq > next) return -1;
      if (Math.abs(freq - next) <= 0.05) return 0;
      return 1;
    });
    ajus.pop();
    var maxAjus = d3.max(ajus);
    var minAjus = d3.min(ajus);
    // If it never grows or shrinks, it returns flat
    if (minAjus === 0 && maxAjus === 0) return 'F';
    else if (maxAjus < 1) return 'L';
    else if (minAjus > -1) return 'J';
    else {
      var uniques = _.uniq(ajus);
      var A_TYPES = [[1, -1], [1, 0, -1], [1, -1, 0], [0, 1, -1]];
      var U_TYPES = [[-1, 1], [-1, 0, 1], [-1, 1, 0], [0, -1, 1]];
      if (A_TYPES.some(function (e) {
        return _.isEqual(e, uniques);
      })) return 'A';
      else if (U_TYPES.some(function (e) {
        return _.isEqual(e, uniques);
      })) return 'U';
      else return 'S';
    }
  },

  toJSON: function (d) {
    var columnType = this.get('column_type');
    var offset = this.get('offset');

    var options = {
      column: this.get('column')
    };

    if (columnType === 'number' && this.get('bins')) {
      options.bins = this.get('bins');
    } else if (columnType === 'date') {
      options.aggregation = this.get('aggregation') || 'auto';

      if (_.isFinite(offset)) {
        options.offset = offset;
      }
    }

    return {
      type: 'histogram',
      source: { id: this.getSourceId() },
      options: options
    };
  },

  _onChangeLayerMeta: function () {
    this.filter.set('column_type', this.layer.get('meta').column_type);
  },

  _onChangeBinds: function () {
    DataviewModelBase.prototype._onChangeBinds.call(this);
  },

  _onUrlChanged: function () {
    this._originalData.set({
      aggregation: this.get('aggregation'),
      offset: this.get('offset'),
      bins: this.get('bins')
    }, { silent: true });

    this._originalData.setUrl(this.get('url'));
  },

  _onDataChanged: function (model) {
    var range = model.getCurrentStartEnd();
    this.set({
      start: range.start,
      end: range.end
    });

    this.set({
      aggregation: model.get('aggregation') || 'minute',
      offset: model.get('offset') || 0,
      bins: model.get('bins'),
      error: model.get('error')
    }, { silent: true });

    var resetFilter = false;

    if (this.get('column_type') === 'date' && (_.has(this.changed, 'aggregation') || _.has(this.changed, 'offset'))) {
      resetFilter = true;
    } else if (this.get('column_type') === 'number' && _.has(this.changed, 'bins')) {
      resetFilter = true;
    }

    resetFilter
      ? this._resetFilterAndFetch()
      : this.fetch();
  },

  _onFieldsChanged: function () {
    if (!helper.hasChangedSomeOf(['offset', 'bins', 'aggregation'], this.changed)) {
      return;
    }

    if (this.get('column_type') === 'number') {
      this._originalData.set('bins', this.get('bins'));
    }
    if (this.get('column_type') === 'date') {
      this._originalData.set({
        offset: this.get('offset'),
        aggregation: this.get('aggregation')
      });
    }
  },

  _resetFilterAndFetch: function () {
    this._resetFilter();
    this.fetch();
  },

  _resetFilter: function () {
    this.disableFilter();
    this.filter.unsetRange();
  },

  _getCurrentOffset: function () {
    return this.get('localTimezone')
      ? this._localOffset
      : this.get('offset');
  }
},

  // Class props
  {
    ATTRS_NAMES: DataviewModelBase.ATTRS_NAMES.concat([
      'column',
      'column_type',
      'bins',
      'min',
      'max',
      'aggregation',
      'offset'
    ])
  }
);
