"""add pg trigger for aggregate plays

This migration updates the DB to use a pg trigger to update the
aggregate_plays table instead of using a celery task
1. Update the aggreagate_plays table to be up to date
   This provides consistency and is a precursor to updating
   the table via pg triggers
2. Create the handle_play function to increment the play item's count
3. Register the function as a pg trigger on insert to plays table

Revision ID: 38642fb2948d
Revises: cdf1f6197fc6
Create Date: 2022-06-13 20:28:06.487553

"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "38642fb2948d"
down_revision = "cdf1f6197fc6"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    connection.execute(
        """
        begin;
            WITH new_plays AS (
                SELECT
                    play_item_id,
                    count(play_item_id) AS count
                FROM
                    plays p
                WHERE
                    p.id > (select last_checkpoint from indexing_checkpoints where tablename='aggregate_plays')
                GROUP BY
                    play_item_id
            )
            INSERT INTO
                aggregate_plays (play_item_id, count)
            SELECT
                new_plays.play_item_id,
                new_plays.count
            FROM
                new_plays ON CONFLICT (play_item_id) DO
            UPDATE
            SET
                count = aggregate_plays.count + EXCLUDED.count;
        
            -- Create the update plays trigger

            create or replace function handle_play() returns trigger as $$
            begin

            insert into aggregate_plays (play_item_id, count) values (new.play_item_id, 0) on conflict do nothing;

            update aggregate_plays
            set count = count + 1 
            where play_item_id = new.play_item_id;

            return null;
            end; 
            $$ language plpgsql;

            drop trigger if exists trg_plays on plays;
            create trigger trg_plays
            after insert on plays
            for each row execute procedure handle_play();
                commit;
        commit;
    """
    )


def downgrade():
    connection = op.get_bind()
    connection.execute("drop trigger if exists trg_plays on plays;")
