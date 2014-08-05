'use strict';


var User  = require('mongoose').model('user');
var Board = require('mongoose').model('board');

var utils      = require('../utils');
var config     = require('../config');
var emitter    = require('../config/emitter');
var middleware = require('../middleware');

var router  = require('express').Router();
var request = require('request');

// automagically fetch documents matching id
router.param('user_id',   middleware.resolve.user());
router.param('board_id',  middleware.resolve.board());
router.param('ticket_id', middleware.resolve.ticket());

// invoke screenshot refresh when board_id is present in the request
// router.param('board_id', middleware.screenshot());

/**
 * boards
 */
router.route('/')

	/**
	 * GET /boards
	 */
	.get(middleware.authenticate('user', 'anonymous'))
	.get(function(req, res, next) {

		var bquery = null;

		if(!req.user) {
			bquery = Board.find({ isPublic: true });
		}
		else {
			bquery = Board.find().or([
				{ owner: req.user.id },
				{ members: req.user.id },
				{ isPublic: true }
			]);
		}

		bquery.select('-tickets').exec(utils.err(next, function(boards) {
			return res.json(200, boards);
		}));
	})

	/**
	 * POST /boards
	 */
	.post(middleware.authenticate('user'))
	.post(function(req, res, next) {

		var board = new Board({
			name:     req.body.name,
			info:     req.body.info,
			isPublic: req.body.isPublic,
			owner:    req.user.id
		});

		res.status(400);
		board.save(utils.err(next, function(boards) {
			return res.json(201, board);
		}));
	});

/**
 * boards/:board_id
 */
router.route('/:board_id')

	/**
	 * GET /boards/:board_id
	 */
	.get(middleware.authenticate('user', 'anonymous'))
	.get(middleware.relation('*'))
	.get(function(req, res, next) {
		Board.populate(req.resolved.board, 'owner members',
			utils.err(next, function(board) {
				return res.json(200, board);
			}));
	})

	/**
	 * PUT /boards/:board_id
	 */
	.put(middleware.authenticate('user'))
	.put(middleware.relation('owner'))
	.put(function(req, res, next) {

		var board = req.resolved.board;

		board.name     = req.body.name;
		board.info     = req.body.info;
		board.isPublic = req.body.isPublic;

		res.status(400);
		board.save(utils.err(next, function(board) {
			return res.json(200, board);
		}));
	})

	/**
	 * DELETE /boards/:board_id
	 */
	.delete(middleware.authenticate('user'))
	.delete(middleware.relation('owner'))
	.delete(function(req, res, next) {
		req.resolved.board.remove(utils.err(next, function() {
			return res.json(200, req.resolved.board);
		}));
	});

/**
 * boards/:board_id/users
 */
router.route('/:board_id/users')

	/**
	 * GET /boards/:board_id/users
	 */
	.get(middleware.authenticate('user', 'anonymous'))
	.get(middleware.relation('*'))
	.get(function(req, res, next) {
		Board.populate(req.resolved.board, 'owner members',
			utils.err(next, function(board) {
				return res.json(200, {
					owner:   board.owner,
					members: board.members
				});
			}));
	})

	/**
	 * POST /boards/:board_id/users
	 */
	.post(middleware.authenticate('user'))
	.post(middleware.relation('owner'))
	.post(function(req, res, next) {
		res.status(400);
		User.find({ _id: req.body.id }, utils.err(next, function(users) {
			var user = users[0];
			if(!user) {
				return next(new Error('User not found'));
			}

			var board = req.resolved.board;
			if(board.isOwner(user) || board.isMember(user)) {
				return next(new Error('User already exists on board'));
			}

			board.members.push(user.id);
			board.save(utils.err(next, function() {
				return res.json(200, user);
			}));
		}));
	});

/**
 * boards/:board_id/users/:user_id
 */
router.route('/:board_id/users/:user_id')

	/**
	 * GET /boards/:board_id/users/:user_id
	 */
	.get(middleware.authenticate('user', 'anonymous'))
	.get(middleware.relation('*'))
	.get(function(req, res, next) {

		var user  = req.resolved.user;
		var board = req.resolved.board;

		if(board.isOwner(user) || board.isMember(user)) {
			return res.json(200, user);
		}

		return next(utils.error(404, 'Not found'));
	})

	/**
	 * DELETE /boards/:board_id/users/:user_id
	 */
	.delete(middleware.authenticate('user'))
	.delete(middleware.relation('owner'))
	.delete(function(req, res, next) {

		var user  = req.resolved.user;
		var board = req.resolved.board;

		res.status(400);

		board.members.pull(user.id);
		board.save(utils.err(next, function() {
			return res.json(200, user);
		}));
	});

/**
 * boards/:board_id/tickets
 */
router.route('/:board_id/tickets')

	/**
	 * GET /boards/:board_id/tickets
	 */
	.get(middleware.authenticate('user', 'anonymous'))
	.get(middleware.relation('*'))
	.get(function(req, res) {
		return res.json(200, req.resolved.board.tickets);
	})

	/**
	 * POST /boards/:board_id/tickets
	 */
	.post(middleware.authenticate('user'))
	.post(middleware.relation('member', 'owner'))
	.post(function(req, res, next) {

		var board  = req.resolved.board;
		var ticket = board.tickets.create({
			owner:    req.user.id,
			color:    req.body.color,
			heading:  req.body.heading,
			content:  req.body.content,
			position: req.body.position
		});

		res.status(400);

		board.tickets.push(ticket);
		board.save(utils.err(next, function() {
			emitter.to(board.id)
				.emit('ticket:create', {
					user:    req.user,
					tickets: [ ticket.toObject() ]
				});
			return res.json(201, ticket);
		}));
	})

	/**
	 * DELETE /boards/:board_id/tickets?tickets=123,124,126
	 */
	.delete(middleware.authenticate('user'))
	.delete(middleware.relation('member', 'owner'))
	.delete(function(req, res, next) {

		var ids     = [ ]
		var removed = [ ]

		var board = req.resolved.board;

		if(req.query.tickets) {
			ids = req.query.tickets.split(',');
		}

		for(var i = 0; i < ids.length; i++) {
			var ticket = board.tickets.id(ids[i]);

			if(ticket) {
				ticket.remove();
				removed.push(ticket.toObject());
			}
			else return next(utils.error(400, 'Invalid parameters'));
		}

		board.save(function(err, board) {
			if(err) {
				if(err.name == 'VersionError') {
					return next(utils.error(409, 'Conflict!'));
				}
				return next(err);
			}
			emitter.to(board.id).emit('ticket:remove', {
				user:    req.user,
				tickets: removed
			});
			return res.json(200, removed);
		});
	});

/**
 * boards/:board_id/tickets/:ticket_id
 */
router.route('/:board_id/tickets/:ticket_id')

	/**
	 * GET /boards/:board_id/tickets/:ticket_id
	 */
	.get(middleware.authenticate('user', 'anonymous'))
	.get(middleware.relation('*'))
	.get(function(req, res) {
		return res.json(200, req.resolved.ticket);
	})

	/**
	 * PUT /boards/:board_id/tickets/:ticket_id
	 */
	.put(middleware.authenticate('user'))
	.put(middleware.relation('member', 'owner'))
	.put(function(req, res, next) {

		var board  = req.resolved.board;
		var ticket = req.resolved.ticket;

		ticket.color    = req.body.color    || ticket.color;
		ticket.heading  = req.body.heading  || ticket.heading;
		ticket.content  = req.body.content  || ticket.content;
		ticket.position = req.body.position || ticket.position;

		res.status(400);
		board.save(utils.err(next, function(board) {
			var updated = board.tickets.id(ticket.id);
			emitter.to(board.id)
				.emit('ticket:update', {
					user:    req.user,
					tickets: [ updated.toObject() ]
				});
			return res.json(200, updated);
		}));
	})

	/**
	 * DELETE /boards/:board_id/tickets/:ticket_id
	 */
	.delete(middleware.authenticate('user'))
	.delete(middleware.relation('member', 'owner'))
	.delete(function(req, res, next) {

		var board  = req.resolved.board;
		var ticket = req.resolved.ticket;

		board.tickets.remove({ _id: ticket.id });
		board.save(function(err, board) {
			if(err) {
				if(err.name == 'VersionError') {
					return next(utils.error(409, "Conflict!"));
				}
				return next(err);
			}
			emitter.to(board.id)
				.emit('ticket:remove', {
					user:    req.user,
					tickets: [ ticket.toObject() ]
				});
			return res.json(200, ticket);
		});
	});

router.route('/:board_id/screenshot')

	/**
	 * GET /boards/:board_id/screenshot
	 */
	.get(middleware.authenticate('user', 'anonymous'))
	.get(middleware.relation('*'))
	.get(function(req, res, next) {
		var url = config.static.url + ':' + config.static.port +
			'/boards' + req.path;
		return request.get(url,
			function(err) {
				if(err) {
					return res.send(503, "screenshot-service unavailable");
				}
			})
			.pipe(res);
	});


module.exports = router;