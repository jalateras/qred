var fs = require("fs");

/*jshint es5:true*/
function Manager(opts) {
    if(!opts) {
        throw new Error("Must provide options name, rclient, rsclient");
    }

    if(!opts.name) throw new Error("Must provide a queue name");
    /*jshint evil:true*/
    if(!opts.redis || !opts.redis.publish || !opts.redis.eval) throw new Error("Must provide option 'redis' which is a redis client that offers the commands: publish, eval"); 
    if(!opts.subscriber || !opts.subscriber.subscribe || !opts.subscriber.on) throw new Error("Must provide an options 'subscriber' which is a redis client that offers the commands: subscribe, on('message')"); 

    //Log helper
    this.log= opts.log|| function() {};

    //Global concurrency settings
    //TODO - set these in redis, but only if explicitly passed in
    this.globalconcurrency = opts.globalconcurrency || 0;
    this.maxperperiod = opts.maxperperiod || 0;
    this.period = opts.period || 0;

    this.completion_callbacks = {};

    this.redis = opts.redis;

    //Redis key names
    this.prefix = opts.prefix || "qred";
    this.name = opts.name;

    this.completion_channel_name = [this.prefix,this.name,'finished'].join(':');
    this.submission_channel_name = [this.prefix,this.name,'submitted'].join(':');
    this.queuekey = [this.prefix,this.name,'queued'].join(':');
    this.delayqueuekey = [this.prefix,this.name,'delayed'].join(':');
    this.datahashkey = [this.prefix,this.name,'data'].join(':');
    this.priorityhashkey = [this.prefix,this.name,'priority'].join(':');
    this.runtimehashkey = [this.prefix,this.name,'runtime'].join(':');
    this.createdhashkey = [this.prefix,this.name,'created'].join(':');

    //Set up subsriptions
    opts.subscriber.subscribe(this.completion_channel_name, function(err) {
        if(err) throw new Error("Couldn't subscribe to redis completion channel");
    });
    opts.subscriber.on('message', this._handleMessage.bind(this));
}

//Handle job completion messages from redis
Manager.prototype._handleMessage = function(channel, message) {
    if(channel === this.completion_channel_name) {
        try {
            message = JSON.parse(message);
        } catch (err) {
            this.log("Unparseable msg "+message);
            return;
        }
        if(!message || !message.jobid || (!message.result && !message.error)) {
            this.log("Unknown message received on queue channel: "+JSON.stringify(message));
            return;
        }
        this._handleCompletion(message.jobid, message.error, message.result);
    }
};

//Internal method to handle completion publication messages
//This checks to see if any local callbacks are pending for the job ID
//if so, they are called with the published error & results
Manager.prototype._handleCompletion = function handleCompletion(jobid, err, result) {
    var callbacks = this.completion_callbacks[jobid];
    delete this.completion_callbacks[jobid];
    if(!callbacks) {
        return;
    }
    for(var i = 0; i < callbacks.length; i++) {
        callbacks[i](err, result);
    }
};
//Submit a job to the queue
//jobid - a name that uniquely defines the job. If a job exists in the queue with the same jobid, this job will replace it!
//data - an object with data to pass to the job. Will be stored in redis as a JSON blob
//opts - optional parameters for the job: priority, delay
//callback - called when job submission completes, or if an error occurs during submission or execution
Manager.prototype.submitJob = function submitJob(jobid, data, opts, callback) {
    var self = this;
    opts = opts || {};

    /*jshint evil:true*/
    self.redis.eval(scripts.addJob, 6, 
                    this.queuekey, this.delayqueuekey, 
                    this.datahashkey, this.priorityhashkey, this.runtimehashkey, this.createdhashkey,
                    jobid, JSON.stringify(data), opts.priority || 0, Date.now(), opts.delay || 0, 
                    function(err) {
        var callbacks = self.completion_callbacks[jobid];
        if(!callbacks) {
            callbacks = self.completion_callbacks[jobid] = [];
        }
        if(err) {
            return callback(err);
        } else {
            self.redis.publish(self.submission_channel_name, jobid);
            callbacks.push(callback);
        }
    }); 
};

//Find a job in this queue with the given ID
Manager.prototype.findJob = function findJob(jobid, callback) {
    /*jshint evil:true*/
    this.redis.eval(scripts.findJob, 4,
                    this.datahashkey, this.priorityhashkey, this.runtimehashkey, this.createdhashkey,
                    jobid, 
                    callback); 
};


//Remove a job in this queue with the given ID
//All callbacks for the job will be removed as well.
Manager.prototype.removeJob = function removeJob(jobid, callback) {
    delete this.completion_callbacks[jobid];
    /*jshint evil:true*/
    this.redis.eval(scripts.removeJob, 6,
                    this.queuekey, this.delayqueuekey, 
                    this.datahashkey, this.priorityhashkey, this.runtimehashkey, this.createdhashkey,
                    jobid, 
                    callback); 
};

//Job is hash with fields:
//  group - the concurrency group of the job (i.e…. the named queue)
//  priority - relative priority of the job. lower priorities will all be run before higher priorities, respecting delay
//  runtime - the time after which the job may be run
//  data - a generic JSON payload passed back to the worker


//EXAMPLE KEYS
//Queue Name - sample
//Job Names: jobA (priority -1), jobB (priority 0), jobC (priority -1)
//
//A job has a few properties, each stored in a different hash keyed on jobid
//We store this way so that we can get various job properties without dynamically generating
//keys in scripts. This keeps scripts compatible with Redis Cluster.
//
//hash qred:sample::data
//hash qred:sample:priority
//hash qred:sample:runtime
//hash qred:sample:created
//
//zset qred:sample:delayed <set of job ids scored by runtime>
//zset qred:samples:queued <set of job ids scored by priority>
//

//Later functionality: 
//Store the max number of jobs globally this queue should run at once (global concurrency)
//value qred:sample:maxjobs 5
//Store the max number of jobs globally this queue should start per second (global ratelimit)
//value qred:sample:perjobs 5
//Number of jobs currently running
//value qred:sample:current <n>
//Maintain list of active jobs
//set qred:samples:active <set of job ids>

var scripts = {
    addJob: fs.readFileSync("lua/addJob.lua"),
    removeJob: fs.readFileSync("lua/removeJob.lua"),
    getJob: fs.readFileSync("lua/getJob.lua"),
};

module.exports = Manager;