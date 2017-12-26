#!/usr/bin/env node
const program = require('commander');
const PomeloClient = require('../pomelo-client');
const console = require('console');

program
  .version('0.0.2')
  .usage('pomelo-client')
  .option('-H --host <host>', 'host', '127.0.0.1')
  .option('-p --port <port>', 'port', 1234)
  .option('-t --timeout <timeout>', 'request timeout', 10000);

program
  .command('request <route> [msg]')
  .description('pomelo request with route and msg')
  .alias('r')
  .action((route, msg) => {
    console.log(`connect to ws://${program.host}:${program.port}`);
    (async () => {
      const client = new PomeloClient();
      await client.init(
        {
          host: program.host,
          port: program.port,
        },
        program.timeout,
      );

      const resp = await client.request(route, msg, program.timeout);
      console.log(resp);

      client.disconnect();
    })().catch(e => console.error(e));
  });

program.parse(process.argv);
