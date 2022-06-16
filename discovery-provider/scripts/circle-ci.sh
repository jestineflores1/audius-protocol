#!/bin/bash
source ./scripts/utilities.sh

function main {
  set -e
  source env/bin/activate

  # run contract migrations
  cd_contracts_repo
  echo 'Migrating contracts'
  node_modules/.bin/truffle migrate --network test_local
  echo 'Writing contracts flask config'
  node_modules/.bin/truffle exec scripts/migrate-contracts.js --network test_local

  # run eth-contracts migrations
  cd_eth_contracts_repo
  echo 'Migrating eth-contracts'
  node_modules/.bin/truffle migrate --network test_local
  echo 'Writing eth-contracts flask config'
  node_modules/.bin/truffle exec scripts/migrate-contracts.js --network test_local

  # run database migrations
  cd_discprov_repo
  echo 'Running alembic migrations'
  export PYTHONPATH='.'
  alembic upgrade head
  echo 'Finished running migrations'

  pytest -s -v --fulltrace
}

main
