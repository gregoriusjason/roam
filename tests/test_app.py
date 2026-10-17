import base64
import json
import os
import re
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from app import app
from backend.places import PLACES, LOCATIONS
from backend.routing import plan_route, validate_location
from backend.storage import db
from backend.todo import todos


class AppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        app.config.update(TESTING=True, DATABASE=str(Path(self.temp.name) / 'test.sqlite'), SECRET_KEY='test-session-secret')
        self.env = patch.dict(os.environ, {'OPENAI_API_KEY':'', 'AUTH_PROVIDER':'local'})
        self.env.start()
        self.client = app.test_client()
        self.client.get('/api/state')

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def csrf(self, client=None):
        with (client or self.client).session_transaction() as s:
            return s['csrf']

    def post(self, path, data=None, client=None, method='post', **kwargs):
        client = client or self.client
        return getattr(client, method)(path, json=data, headers={'X-CSRF-Token':self.csrf(client)}, **kwargs)

    def register(self, email='explorer@example.test', client=None):
        client=client or self.client
        client.get('/register')
        return client.post('/register', data={'csrf_token':self.csrf(client), 'full_name':'Test Explorer',
                         'email':email,'password':'a-long-test-password'})

    def note(self, message='This street has colourful shopfronts.', **kwargs):
        return self.post('/api/chat', {'message':message,'checkpoint':PLACES[1],**kwargs})

    def route_fixture(self):
        return {'origin':LOCATIONS[-3], 'destination':LOCATIONS[-2], 'checkpoints':[PLACES[1]],
                'geometry':{'type':'LineString','coordinates':[[-3.189,55.952],[-3.1935,55.9481],[-3.1896,55.9445]]},
                'distance':1500, 'walking_minutes':20, 'total_minutes':25, 'buffer_minutes':30,
                'direct_minutes':15, 'mode':'discovery','new_places':1,'interests':['History'],'warnings':[]}

    def create_route(self):
        with patch('backend.web.plan_route', return_value=self.route_fixture()):
            return self.post('/api/routes',{'origin':LOCATIONS[-3],'destination':LOCATIONS[-2],
                'arrival_at':(datetime.now(timezone.utc)+timedelta(minutes=70)).isoformat(),'interests':['History']})

    def test_homepage_and_assets(self):
        for path in ('/', '/welcome', '/login', '/register'):
            response=self.client.get(path)
            self.assertEqual(response.status_code,200)
            html=response.get_data(as_text=True)
            self.assertIn('roam',html)
            for asset in re.findall(r'(?:href|src)="(/static/[^\"]+)"',html):
                with self.subTest(asset=asset):
                    result=self.client.get(asset)
                    self.assertEqual(result.status_code,200)
                    result.close()

    def test_legacy_todos_remain_available(self):
        response=self.client.get('/todos')
        self.assertIn('hx-post="/search"',response.get_data(as_text=True))
        response=self.client.post('/search',data={'search':'delectus','csrf_token':self.csrf()})
        self.assertIn('delectus aut autem',response.get_data(as_text=True))
        self.assertNotIn('<html',response.get_data(as_text=True))

    def test_csrf_required_for_mutations(self):
        self.assertEqual(self.client.post('/api/chat',json={'message':'hello'}).status_code,403)
        self.assertEqual(self.client.post('/register',data={'email':'test@example.test'}).status_code,403)

    def test_health_exposes_only_configuration(self):
        payload=self.client.get('/api/health/integrations').json
        self.assertFalse(payload['openai']['configured'])
        self.assertNotIn('key',json.dumps(payload))

    def test_guest_note_saved_without_api_key(self):
        response=self.note()
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json['mode'],'preview')
        state=self.client.get('/api/state').json
        self.assertEqual(len(state['memories']),1)
        self.assertEqual(state['memories'][0]['checkpoint']['name'],PLACES[1]['name'])

    def test_json_and_note_validation(self):
        for value in ([],None,'abc',{'message':''},{'message':'x'*4001,'checkpoint':PLACES[1]}):
            with self.subTest(value=str(value)[:40]):
                self.assertEqual(self.post('/api/chat',value).status_code,400)
        self.assertEqual(self.note(photo='data:image/jpeg;base64,not-an-image').status_code,400)
        self.assertEqual(self.note(photo='https://example.test/photo.jpg').status_code,400)
        self.assertEqual(self.client.get('/api/state').json['memories'],[])

    def test_photo_is_persisted(self):
        png=base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'test').decode()
        photo='data:image/png;base64,'+png
        self.assertEqual(self.note(photo=photo).status_code,200)
        self.assertEqual(self.client.get('/api/state').json['memories'][0]['photo'],photo)

    def test_guest_memories_migrate_and_password_is_hashed(self):
        self.note()
        old_csrf=self.csrf()
        self.assertEqual(self.register().status_code,302)
        state=self.client.get('/api/state').json
        self.assertEqual(state['user']['full_name'],'Test Explorer')
        self.assertEqual(len(state['memories']),1)
        self.assertNotEqual(old_csrf,self.csrf())
        with app.app_context():
            user=db().execute('SELECT * FROM users').fetchone()
            self.assertNotEqual(user['password_hash'],'a-long-test-password')
        self.post('/logout')
        self.assertEqual(self.client.get('/api/state').json['memories'],[])
        response=self.client.post('/login',data={'csrf_token':self.csrf(),'email':'explorer@example.test','password':'a-long-test-password'})
        self.assertEqual(response.status_code,302)
        self.assertEqual(len(self.client.get('/api/state').json['memories']),1)

    def test_duplicate_email_and_bad_login(self):
        self.register();self.post('/logout')
        self.assertEqual(self.register().status_code,400)
        bad=self.client.post('/login',data={'csrf_token':self.csrf(),'email':'explorer@example.test','password':'incorrect-password'})
        self.assertEqual(bad.status_code,401)
        self.assertIsNone(self.client.get('/api/state').json['user'])

    def test_user_data_is_isolated(self):
        self.register();response=self.note();memory_id=response.json['memory_id']
        journey=self.create_route().json['route']
        other=app.test_client();other.get('/api/state');self.register('other@example.test',other)
        self.assertEqual(other.get('/api/state').json['memories'],[])
        self.assertEqual(self.post('/api/memories/'+memory_id,client=other,method='delete').status_code,404)
        self.assertEqual(self.post('/api/journeys/'+journey['id'],{'action':'start'},client=other).status_code,404)
        self.assertEqual(self.post('/api/chat',{'message':'Intrusion','checkpoint':PLACES[1],'journey_id':journey['id']},client=other).status_code,400)

    def test_ai_receives_previous_memories_and_failure_does_not_lose_note(self):
        self.register();self.note('I found a tiny blue door here.')
        with patch('backend.web.openai_configured',return_value=True),patch('backend.web.request_chat_completion',return_value='What is beside the door?') as model:
            result=self.note('There is a sign beside it.')
            self.assertEqual(result.json['mode'],'ai')
            self.assertEqual(model.call_args.args[2][0]['content'],'I found a tiny blue door here.')
        with patch('backend.web.openai_configured',return_value=True),patch('backend.web.request_chat_completion',side_effect=RuntimeError('private-provider-debug')):
            result=self.note('The door is painted blue.')
            self.assertEqual(result.json['mode'],'unavailable')
            self.assertNotIn('private-provider-debug',result.get_data(as_text=True))
        self.assertEqual(len(self.client.get('/api/state').json['memories']),3)

    def test_guest_ai_works_before_login(self):
        with patch('backend.web.openai_configured',return_value=True),patch('backend.web.request_chat_completion',return_value='What else stands out?') as model:
            result=self.note()
            self.assertEqual(result.json['mode'],'ai')
            self.assertEqual(result.json['reply'],'What else stands out?')
            model.assert_called_once()

    def test_route_photo_is_validated_and_passed_to_planner(self):
        png=base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'test').decode()
        photo='data:image/png;base64,'+png
        with patch('backend.web.plan_route',return_value=self.route_fixture()) as planner:
            result=self.post('/api/routes',{'origin':LOCATIONS[-3],'destination':LOCATIONS[-2],
                'arrival_at':(datetime.now(timezone.utc)+timedelta(minutes=70)).isoformat(),
                'interests':['History'],'photo':photo})
        self.assertEqual(result.status_code,200)
        self.assertEqual(planner.call_args.kwargs['photo'],photo)

    def test_memory_deletion_clears_context(self):
        self.register()
        with patch('backend.web.openai_configured',return_value=True),patch('backend.web.request_chat_completion',return_value='A blue door!'):
            response=self.note('A blue door.')
        self.assertEqual(self.post('/api/memories/'+response.json['memory_id'],method='delete').status_code,200)
        self.assertEqual(self.client.get('/api/state').json['memories'],[])
        with app.app_context():self.assertEqual(db().execute('SELECT COUNT(*) FROM messages').fetchone()[0],0)

    def test_journey_progress_summary_and_revisit_filter(self):
        route=self.create_route().json['route'];path='/api/journeys/'+route['id']
        self.assertEqual(self.post(path,{'action':'visit','checkpoint_id':PLACES[1]['id']}).status_code,400)
        self.assertEqual(self.post(path,{'action':'start'}).status_code,200)
        self.assertEqual(self.post(path,{'action':'visit','checkpoint_id':'wrong'}).status_code,400)
        self.post(path,{'action':'visit','checkpoint_id':PLACES[1]['id']})
        self.post(path,{'action':'visit','checkpoint_id':PLACES[1]['id']})
        self.note(journey_id=route['id']);self.post(path,{'action':'finish'})
        state=self.client.get('/api/state').json
        self.assertEqual(state['journeys'][0]['completed_stops'],[PLACES[1]['id']])
        self.assertEqual(state['journeys'][0]['status'],'completed')
        self.assertEqual(state['memories'][0]['journey_id'],route['id'])
        with patch('backend.web.plan_route',return_value=self.route_fixture()) as planner:
            self.post('/api/routes',{'origin':LOCATIONS[-3],'destination':LOCATIONS[-2],
                'arrival_at':(datetime.now(timezone.utc)+timedelta(minutes=70)).isoformat(),'interests':[]})
            self.assertIn(PLACES[1]['id'],planner.call_args.args[4])

    def test_arrival_and_coordinate_validation(self):
        for origin in ({'name':'x','lat':float('nan'),'lng':0},{'name':'x','lat':100,'lng':0},'a place'):
            with self.assertRaises(ValueError):validate_location(origin)
        for arrival in ('not-a-date',(datetime.now(timezone.utc)-timedelta(minutes=1)).isoformat(),datetime.now().isoformat()):
            self.assertEqual(self.post('/api/routes',{'origin':LOCATIONS[-3],'destination':LOCATIONS[-2],'arrival_at':arrival}).status_code,400)


class RoutePlannerTests(unittest.TestCase):
    def setUp(self):
        self.env=patch.dict(os.environ,{'OPENAI_API_KEY':''});self.env.start()
        self.origin,self.destination=LOCATIONS[-3],LOCATIONS[-2]

    def tearDown(self):self.env.stop()

    @staticmethod
    def walking(points):
        return {'geometry':{'type':'LineString','coordinates':[[p['lng'],p['lat']] for p in points]},
                'distance':len(points)*400,'walking_minutes':len(points)*6}

    def test_new_only_routes_never_contain_visited_checkpoints(self):
        visited={PLACES[0]['id'],PLACES[1]['id'],PLACES[4]['id']}
        with patch('backend.routing.route_for',side_effect=self.walking):
            result=plan_route(self.origin,self.destination,70,['History'],visited)
        self.assertFalse(visited.intersection(p['id'] for p in result['checkpoints']))
        self.assertLessEqual(result['total_minutes']+5,70)
        self.assertGreater(len(result['checkpoints']),0)

    def test_too_short_arrival_is_rejected(self):
        with patch('backend.routing.route_for',return_value={'walking_minutes':40}):
            with self.assertRaisesRegex(ValueError,'direct walk'):
                plan_route(self.origin,self.destination,20,[],set())

    def test_stop_count_reduced_to_actual_walking_budget(self):
        def slow(points):
            r=self.walking(points);r['walking_minutes']=15+(len(points)-2)*20;return r
        with patch('backend.routing.route_for',side_effect=slow):
            result=plan_route(self.origin,self.destination,50,[],set())
        self.assertLessEqual(result['total_minutes']+5,50)
        self.assertLessEqual(len(result['checkpoints']),1)

    def test_all_explored_gives_honest_direct_route(self):
        with patch('backend.routing.route_for',side_effect=self.walking):
            result=plan_route(self.origin,self.destination,70,[],{p['id'] for p in PLACES})
        self.assertEqual(result['checkpoints'],[])
        self.assertTrue(result['warnings'])

    def test_ai_can_only_rank_known_candidates(self):
        with patch('backend.routing.route_for',side_effect=self.walking),patch('backend.routing.openai_configured',return_value=True),patch('backend.routing.rank_checkpoints',return_value=['imaginary-place',PLACES[1]['id']]):
            result=plan_route(self.origin,self.destination,70,['Hidden gems'],set())
        self.assertNotIn('imaginary-place',[p['id'] for p in result['checkpoints']])


if __name__=='__main__':unittest.main()
